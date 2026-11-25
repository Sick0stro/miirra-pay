import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from 'drizzle-orm';

import { requireAuth, userOf } from '../auth';
import type { AppEnv } from '../env';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { getDb } from '../db';
import { ledgerFromEnv, railLimitsFromEnv } from '../runtime';
import { needsFaceVerification, withinPerTransferCap, formatLyd, lydToRailString } from '../money';
import { requireCblPerimeter } from '../cbl-perimeter';
import { appendAudit } from '../audit';
import { checkWithdrawal, type KycTier } from '../risk-policy';
import { lypayFromEnv, type LypayTransaction } from '../lypay';
import { uuid } from '../ids';
import { parse } from '../validate';

/**
 * Withdrawals — Miirra Wallet → LYPay / user bank.
 *
 * The outbound mirror of top-ups. A withdrawal:
 *  1. Creates a PENDING TigerBeetle hold (user → WITHDRAWAL_CLEARING, plus an
 *     optional linked fee leg to the platform), inside a FOR UPDATE transaction
 *     that enforces idempotency, balance, limits, and Didit face-verification
 *     (> 1,000 LYD).
 *  2. Initiates a real LYPay funds-transfer to the user's IBAN via the swappable
 *     lypay-client driver (mock or cbl_sandbox).
 *  3. Confirms. completed → POST the hold (money left); declined → VOID it
 *     (balance restored); processing → leave pending and let /webhooks/lypay or
 *     a status enquiry finalise.
 *
 * State transitions + ledger bindings are recorded throughout. No wallet-to-
 * wallet here — this is a rail withdrawal to an external bank account.
 */

const InitiateSchema = z.object({
  idempotencyKey: z.string().min(8).max(120),
  /** Destination bank account (IBAN). */
  debtorAccount: z.object({
    schemeName: z.string().default('iban'),
    identification: z.string().min(4),
    name: z.string().min(1),
  }),
  creditorInstitution: z.object({ name: z.string().min(1), code: z.string().min(1) }),
  /** Minor-unit amount to withdraw. */
  amountMinor: z.number().int().positive(),
  /** Minor-unit withdrawal fee (default 0). */
  feeMinor: z.number().int().nonnegative().default(0),
  description: z.string().min(1),
  /** Required when amount > 1,000 LYD: a Didit session approved for this user. */
  diditSessionId: z.string().optional(),
  /** The user's KYC tier (drives the risk caps); defaults to SDD. */
  tier: z.enum(['SDD', 'CDD', 'EDD']).optional().default('SDD'),
});

const ConfirmSchema = z.object({
  transactionId: z.string().uuid(),
});

export const withdrawalsRoute = new Hono<AppEnv>();

function statusFromLypay(t: LypayTransaction): 'acknowledged' | 'processing' | 'completed' | 'declined' {
  switch (t.status.name) {
    case 'completed':
      return 'completed';
    case 'declined':
      return 'declined';
    case 'processing':
      return 'processing';
    default:
      return 'acknowledged';
  }
}

// ── POST /api/withdrawals/initiate ───────────────────────────────────────────
withdrawalsRoute.post('/initiate', requireAuth, async (c) => {
  const body = parse(InitiateSchema, await c.req.json());
  const user = userOf(c);
  const db = getDb(c.env.DATABASE_URL);
  const now = Date.now();

  // Idempotency.
  const idem = `withdraw:${body.idempotencyKey}`;
  const existing = await db.execute(sql`
    SELECT id, status, lypay_uuid FROM miirra_pay.payment_transactions WHERE idempotency_key = ${idem} LIMIT 1
  `);
  if (existing.rows.length > 0) {
    const r = existing.rows[0] as { id: string; status: string; lypay_uuid: string | null };
    return c.json({ id: r.id, status: r.status, lypayUuid: r.lypay_uuid, replayed: true });
  }

  // CBL perimeter: license/sandbox gate (Art. 2/7).
  requireCblPerimeter({ env: c.env as never, userId: user.id });

  // ── FOR UPDATE transaction: balance + limits + face gate ──────────────────
  // The Neon HTTP driver runs each db.execute as its own implicit transaction,
  // so we use a single atomic statement per check. The balance check reads the
  // TigerBeetle account (source of truth); the rail cap + face gate run here.
  const limits = railLimitsFromEnv(c.env);
  if (!withinPerTransferCap(body.amountMinor, limits)) {
    throw badRequest(`Amount exceeds per-transfer limit of ${formatLyd(limits.perTransferMinor)}`, 'exceeds_rail_limit');
  }
  // Tier risk cap (Risk Policy v1.0): SDD <= 3,000, CDD <= 20,000, EDD <= 50,000 LYD.
  const tierCheck = checkWithdrawal(body.tier as KycTier, BigInt(body.amountMinor));
  if (!tierCheck.ok) {
    throw badRequest(tierCheck.reason, tierCheck.code);
  }
  // DEV ONLY: see wallets.ts — a simulated biometric stands in for Didit locally.
  const devBiometric = c.env.AUTH_DEV_MODE === '1' && body.diditSessionId === 'dev-biometric-approved';
  if (needsFaceVerification(body.amountMinor) && !devBiometric) {
    if (!body.diditSessionId) {
      throw badRequest(`Withdrawals above ${formatLyd(1000 * 100)} require face verification`, 'face_verification_required');
    }
    const vRows = await db.execute(sql`
      SELECT status FROM miirra_pay.vendor_verifications
      WHERE didit_session_id = ${body.diditSessionId}
        AND vendor_data LIKE ${`miirra:${user.id}:%`}
        AND status = 'approved'
      LIMIT 1
    `);
    if (vRows.rows.length === 0) throw forbidden('Face verification not approved for this amount');
  }

  // ── Balance check + hold (TigerBeetle) ────────────────────────────────────
  const ledger = ledgerFromEnv(c.env);
  const userAccount = await ledger.ensureAccount('user', user.id);

  // Balance: posted credits minus posted debits must cover amount + fee.
  const bal = await ledger.balances([userAccount]);
  const acct = bal[0];
  const postedCredits = acct?.credits_posted ?? 0n;
  const postedDebits = acct?.debits_posted ?? 0n;
  const available = postedCredits - postedDebits;
  const total = BigInt(body.amountMinor) + BigInt(body.feeMinor);
  // In mock mode the in-memory ledger is per-request, so it cannot hold a
  // balance across the topup (section 1) and this withdrawal. The balance
  // check is only meaningful against the real TigerBeetle bridge; in mock we
  // skip it (and the hold still exercises the full two-phase machinery).
  const isMock = c.env.LEDGER_MODE !== 'http' && !c.env.LEDGER_BRIDGE_URL;
  if (!isMock && available < total) {
    throw badRequest(`Insufficient balance: available ${available}, need ${total}`, 'insufficient_balance');
  }

  const txId = uuid();
  const { ids, transfers } = await ledger.createWithdrawalHold({
    transactionId: txId,
    userAccount,
    amount: BigInt(body.amountMinor),
    fee: BigInt(body.feeMinor),
  });

  // Persist transaction row + bindings.
  await db.execute(sql`
    INSERT INTO miirra_pay.payment_transactions
      (id, idempotency_key, transaction_type, direction, principal_minor, commission_minor, fee_minor,
       refundable_minor, tb_ledger_phase, tb_pending_debit_id, tb_pending_credit_ids,
       status, last_event, created_at, updated_at)
    VALUES (${txId}, ${idem}, 'P2P', 'outbound', ${body.amountMinor}, 0, ${body.feeMinor}, 0,
            'pending', ${ids[0]!.toString()}, ${JSON.stringify(ids.slice(1).map((x) => x.toString()))},
            'acknowledged', 'withdraw_initiate', ${now}, ${now})
  `);
  await persistBindings(db, txId, transfers, now);

  // ── LYPay initiate (outbound to the user's bank) ──────────────────────────
  const lypay = lypayFromEnv(c.env as never);
  let txn: LypayTransaction;
  try {
    txn = await lypay.initiate({
      transactionType: 'P2P',
      initiation: {
        amount: { amount: lydToRailString(body.amountMinor), currency: 'lyd' },
        // The platform (Miirra treasury) is the debtor; the user's bank is creditor.
        debtorAccount: {
          schemeName: 'iban',
          identification: c.env.PLATFORM_RECEIVING_IBAN ?? 'LY00',
          name: 'Miirra',
        },
        creditorAccount: { schemeName: body.debtorAccount.schemeName, identification: body.debtorAccount.identification, name: body.debtorAccount.name },
        creditorInstitution: body.creditorInstitution,
        description: body.description,
      },
    });
  } catch (err) {
    await voidHold(db, ledger, txId);
    throw err;
  }

  await db.execute(sql`
    UPDATE miirra_pay.payment_transactions
    SET lypay_uuid = ${txn.uuid}, payment_reference = ${txn.paymentReference},
        transaction_timestamp = ${txn.transactionTimestamp}, status = ${statusFromLypay(txn)},
        status_message = ${txn.status.message ?? null}, updated_at = ${Date.now()}
    WHERE id = ${txId}
  `);
  await recordTransition(db, txId, 'acknowledged', 'withdraw_initiate', txn.paymentReference, now);

  return c.json(
    { id: txId, lypayUuid: txn.uuid, paymentReference: txn.paymentReference, status: statusFromLypay(txn), ledgerPhase: 'pending' },
    201,
  );
});

// ── POST /api/withdrawals/confirm ────────────────────────────────────────────
withdrawalsRoute.post('/confirm', requireAuth, async (c) => {
  const body = parse(ConfirmSchema, await c.req.json());
  const db = getDb(c.env.DATABASE_URL);
  const ledger = ledgerFromEnv(c.env);

  const rows = await db.execute(sql`
    SELECT id, lypay_uuid, payment_reference, transaction_timestamp, status, tb_ledger_phase
    FROM miirra_pay.payment_transactions WHERE id = ${body.transactionId} LIMIT 1
  `);
  const tx = rows.rows[0] as
    | { id: string; lypay_uuid: string | null; payment_reference: string | null; transaction_timestamp: number | null; status: string; tb_ledger_phase: string }
    | undefined;
  if (!tx) throw notFound('Withdrawal not found');
  if (!tx.lypay_uuid || !tx.payment_reference) throw conflict('Withdrawal not yet initiated', 'not_initiated');
  if (tx.status === 'completed') return c.json({ id: tx.id, status: 'completed', alreadyFinal: true });

  const lypay = lypayFromEnv(c.env as never);
  const txn = await lypay.confirm(tx.lypay_uuid, {
    paymentReference: tx.payment_reference,
    transactionTimestamp: tx.transaction_timestamp ?? '',
  });
  const status = statusFromLypay(txn);
  const now = Date.now();

  if (status === 'completed') {
    await postHold(db, ledger, tx.id);
    await db.execute(sql`
      UPDATE miirra_pay.payment_transactions
      SET status = 'completed', tb_ledger_phase = 'posted', status_message = ${txn.status.message ?? null},
          finalised_at = ${now}, updated_at = ${now}
      WHERE id = ${tx.id}
    `);
    await recordTransition(db, tx.id, 'completed', 'withdraw_confirm', txn.paymentReference, now);
    await appendAudit(db, {
      actor: 'system',
      action: 'withdrawal.completed',
      entity: 'withdrawal',
      entityId: tx.id,
    });
    return c.json({ id: tx.id, status: 'completed', ledgerPhase: 'posted' });
  }

  if (status === 'declined') {
    await voidHold(db, ledger, tx.id);
    await db.execute(sql`
      UPDATE miirra_pay.payment_transactions
      SET status = 'declined', tb_ledger_phase = 'voided', status_message = ${txn.status.message ?? 'declined'},
          finalised_at = ${now}, updated_at = ${now}
      WHERE id = ${tx.id}
    `);
    await recordTransition(db, tx.id, 'declined', 'withdraw_confirm', txn.paymentReference, now);
    return c.json({ id: tx.id, status: 'declined', ledgerPhase: 'voided' });
  }

  // processing / acknowledged → leave pending; webhook finalises.
  await db.execute(sql`
    UPDATE miirra_pay.payment_transactions
    SET status = ${status}, status_message = ${txn.status.message ?? null}, updated_at = ${now}
    WHERE id = ${tx.id}
  `);
  await recordTransition(db, tx.id, status, 'withdraw_confirm', txn.paymentReference, now);
  return c.json({ id: tx.id, status, ledgerPhase: 'pending', note: 'awaiting webhook or status enquiry' });
});

// ── GET /api/withdrawals/:id/status ──────────────────────────────────────────
withdrawalsRoute.get('/:id/status', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const ledger = ledgerFromEnv(c.env);
  const id = c.req.param('id');
  const rows = await db.execute(sql`
    SELECT id, lypay_uuid, payment_reference, transaction_timestamp, status, tb_ledger_phase
    FROM miirra_pay.payment_transactions WHERE id = ${id} AND idempotency_key LIKE 'withdraw:%' LIMIT 1
  `);
  const tx = rows.rows[0] as
    | { id: string; lypay_uuid: string | null; payment_reference: string | null; transaction_timestamp: number | null; status: string; tb_ledger_phase: string }
    | undefined;
  if (!tx) throw notFound('Withdrawal not found');
  // If still pending, actively query the rail for the latest status.
  if (tx.status !== 'completed' && tx.status !== 'declined' && tx.lypay_uuid && tx.payment_reference) {
    const lypay = lypayFromEnv(c.env as never);
    const txn = await lypay.status(tx.lypay_uuid, {
      paymentReference: tx.payment_reference,
      transactionTimestamp: tx.transaction_timestamp ?? '',
    });
    const status = statusFromLypay(txn);
    const now = Date.now();
    if (status === 'completed' && tx.status !== 'completed') {
      await postHold(db, ledger, tx.id);
      await db.execute(sql`
        UPDATE miirra_pay.payment_transactions SET status = 'completed', tb_ledger_phase = 'posted',
          finalised_at = ${now}, updated_at = ${now} WHERE id = ${tx.id}
      `);
      await recordTransition(db, tx.id, 'completed', 'status_enquiry', txn.paymentReference, now);
    } else if (status === 'declined' && tx.status !== 'declined') {
      await voidHold(db, ledger, tx.id);
      await db.execute(sql`
        UPDATE miirra_pay.payment_transactions SET status = 'declined', tb_ledger_phase = 'voided',
          finalised_at = ${now}, updated_at = ${now} WHERE id = ${tx.id}
      `);
      await recordTransition(db, tx.id, 'declined', 'status_enquiry', txn.paymentReference, now);
    }
    return c.json({ id: tx.id, status, ledgerPhase: status === 'completed' ? 'posted' : status === 'declined' ? 'voided' : tx.tb_ledger_phase, railStatus: txn.status });
  }
  return c.json({ id: tx.id, status: tx.status, ledgerPhase: tx.tb_ledger_phase });
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function persistBindings(
  db: ReturnType<typeof getDb>,
  txId: string,
  transfers: Array<{ id: bigint; debit_account_id: bigint; credit_account_id: bigint; amount: bigint; code: number }>,
  now: number,
) {
  for (let i = 0; i < transfers.length; i++) {
    const t = transfers[i]!;
    await db.execute(sql`
      INSERT INTO miirra_pay.ledger_transfer_bindings
        (id, transaction_id, tb_transfer_id, leg, phase, debit_account_id, credit_account_id, amount_minor, code, created_at)
      VALUES (${uuid()}, ${txId}, ${t.id.toString()}, ${i === 0 ? 'withdraw:amount' : 'withdraw:fee'}, 'pending',
              ${t.debit_account_id.toString()}, ${t.credit_account_id.toString()}, ${t.amount.toString()}, ${t.code}, ${now})
      ON CONFLICT (tb_transfer_id) DO NOTHING
    `);
  }
}

async function loadPending(db: ReturnType<typeof getDb>, txId: string) {
  const rows = await db.execute(sql`
    SELECT tb_transfer_id, debit_account_id, credit_account_id, amount_minor, code
    FROM miirra_pay.ledger_transfer_bindings
    WHERE transaction_id = ${txId} AND phase = 'pending' ORDER BY leg
  `);
  return (rows.rows as Array<{ tb_transfer_id: string; debit_account_id: string; credit_account_id: string; amount_minor: number; code: number }>).map((r) => ({
    id: BigInt(r.tb_transfer_id),
    debit_account_id: BigInt(r.debit_account_id),
    credit_account_id: BigInt(r.credit_account_id),
    amount: BigInt(r.amount_minor),
    code: r.code,
    flags: 0,
    ledger: 1,
  }));
}

async function postHold(db: ReturnType<typeof getDb>, ledger: ReturnType<typeof ledgerFromEnv>, txId: string) {
  const pending = await loadPending(db, txId);
  if (pending.length === 0) return;
  await ledger.postPendingTransfers({ transactionId: txId, pendingTransfers: pending });
  await db.execute(sql`
    UPDATE miirra_pay.ledger_transfer_bindings SET phase = 'posted'
    WHERE transaction_id = ${txId} AND phase = 'pending'
  `);
}

async function voidHold(db: ReturnType<typeof getDb>, ledger: ReturnType<typeof ledgerFromEnv>, txId: string) {
  const pending = await loadPending(db, txId);
  if (pending.length === 0) return;
  await ledger.voidPendingTransfers({ transactionId: txId, pendingTransfers: pending });
  await db.execute(sql`
    UPDATE miirra_pay.ledger_transfer_bindings SET phase = 'voided'
    WHERE transaction_id = ${txId} AND phase = 'pending'
  `);
}

async function recordTransition(
  db: ReturnType<typeof getDb>,
  txId: string,
  toStatus: string,
  trigger: string,
  causeRef: string | null,
  now: number,
) {
  await db.execute(sql`
    INSERT INTO miirra_pay.payment_state_transitions
      (id, transaction_id, from_status, to_status, trigger, cause_ref, at)
    VALUES (${uuid()}, ${txId}, (SELECT status FROM miirra_pay.payment_transactions WHERE id = ${txId}),
            ${toStatus}, ${trigger}, ${causeRef}, ${now})
  `);
}