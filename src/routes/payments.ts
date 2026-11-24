import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from 'drizzle-orm';

import { requireAuth, userOf } from '../auth';
import type { AppEnv } from '../env';
import { badRequest, conflict, notFound } from '../errors';
import { getDb } from '../db';
import { LedgerService, LedgerCode } from '../ledger-service';
import { type TbTransfer } from '../ledger';
import { SYSTEM, idStr } from '../ledger-codes';
import { ledgerFromEnv, railLimitsFromEnv } from '../runtime';
import { withinPerTransferCap, lydToRailString } from '../money';
import { lypayFromEnv, type LypayTransaction } from '../lypay';
import { internalMerchantReference, uuid } from '../ids';
import { parse } from '../validate';

/**
 * Payments — the LYPay P2P / P2M / M2M initiate → confirm flow, plus M2P
 * refunds, with the TigerBeetle two-phase ledger underneath.
 *
 * NO wallet-to-wallet transfer exists here by design. Every payment moves money
 * between a real debtor and a real creditor at banks reachable over LYPay;
 * Miirra's ledger records and settles the platform's share (commission) out of
 * the same transfer, but it never invents balance between two Miirra users.
 *
 * Flow, precisely:
 *   1. initiate → create the transaction row (idempotent), create a PENDING
 *      split chain in TigerBeetle (payer → clearing → payee + commission),
 *      THEN call LYPay initiate. If LYPay rejects, the pending chain is voided.
 *   2. confirm  → call LYPay confirm. completed → POST the pending chain;
 *      declined → VOID it; processing → leave pending for the webhook.
 *   3. refund   → M2P: POST a new refund transfer up to the remaining refundable
 *      amount, then call LYPay refund.
 *
 * DURABILITY: the pending transfer's full routing (debit/credit account ids,
 * amount, code) is persisted in `ledger_transfer_bindings` at initiate time, so
 * a later post/void — possibly in a different isolate — replays the EXACT same
 * TigerBeetle transfer objects rather than reconstructing them (which would be
 * lossy). This is the crux that makes the two-phase ledger recoverable.
 */

const InitiateSchema = z.object({
  transactionType: z.enum(['P2P', 'P2M', 'M2M']),
  idempotencyKey: z.string().min(8).max(120),
  sender: z.object({
    schemeName: z.string().default('iban'),
    identification: z.string().min(4),
    name: z.string().min(1),
    partyId: z.string().uuid().optional(),
  }),
  receiver: z.object({
    schemeName: z.string().default('iban'),
    identification: z.string().min(4),
    name: z.string().min(1),
    partyId: z.string().uuid().optional(),
  }),
  creditorInstitution: z.object({ name: z.string().min(1), code: z.string().min(1) }),
  /** Minor-unit principal (LYD piastres). */
  amountMinor: z.number().int().positive(),
  /** Minor-unit commission the platform takes out of this payment. */
  commissionMinor: z.number().int().nonnegative().default(0),
  orderId: z.string().uuid().optional(),
  description: z.string().min(1),
  additionalData: z.record(z.string()).optional(),
  /** P2M only: override the generated internal merchant reference. */
  internalMerchantReference: z.string().optional(),
});

const ConfirmSchema = z.object({
  transactionId: z.string().uuid(),
  /** Mock-mode override of how LYPay resolves the confirm. */
  mockPlan: z.enum(['complete', 'decline', 'processing']).optional(),
});

const RefundSchema = z.object({
  transactionId: z.string().uuid(),
  amountMinor: z.number().int().positive(),
  description: z.string().min(1),
  idempotencyKey: z.string().min(8).max(120),
});

export const paymentsRoute = new Hono<AppEnv>();

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

// ── POST /api/payments/initiate ──────────────────────────────────────────────
paymentsRoute.post('/initiate', requireAuth, async (c) => {
  const body = parse(InitiateSchema, await c.req.json());
  const user = userOf(c);
  const db = getDb(c.env.DATABASE_URL);
  const now = Date.now();

  const idem = `pay:${body.idempotencyKey}`;
  const existing = await db.execute(sql`
    SELECT id, status, lypay_uuid FROM miirra_pay.payment_transactions WHERE idempotency_key = ${idem} LIMIT 1
  `);
  if (existing.rows.length > 0) {
    const r = existing.rows[0] as { id: string; status: string; lypay_uuid: string | null };
    return c.json({ id: r.id, status: r.status, lypayUuid: r.lypay_uuid, replayed: true });
  }

  const ledger = ledgerFromEnv(c.env);
  const txId = uuid();

  // Rail cap: reject a single transfer above the configured per-transfer limit
  // BEFORE touching the ledger or the rail. (The face-verification gate for
  // amounts above FACE_VERIFY_THRESHOLD_MINOR is enforced in the wallet flow,
  // where a user moves their own balance; bank-rail P2P/P2M/M2M settlement is
  // capped here.)
  if (!withinPerTransferCap(body.amountMinor, railLimitsFromEnv(c.env))) {
    throw badRequest(`Amount exceeds per-transfer rail limit`, 'exceeds_rail_limit');
  }

  // The payer's TigerBeetle account is keyed on the authenticated user — you can
  // only ever debit your OWN account. A user can never name someone else's
  // Miirra balance as the source (the wallet-to-wallet guard).
  const payerAccount = await ledger.ensureAccount('user', user.id);

  // The commission the platform earns is capped at the principal.
  const commission = Math.min(body.commissionMinor, body.amountMinor);
  const principal = body.amountMinor - commission;

  // Build the split legs. The payee's credit leg only becomes a Miirra account
  // credit when the receiver is a known platform party; otherwise (a plain P2P
  // to an external bank account) the principal flows out via clearing and there
  // is no Miirra-side credit account — the platform's commission is still taken.
  const legs: Array<{ creditTo: any; amount: bigint; code: number }> = [];
  if (body.receiver.partyId) {
    legs.push({ creditTo: { kind: 'merchant', id: body.receiver.partyId }, amount: BigInt(principal), code: LedgerCode.TX_PRINCIPAL });
  } else {
    // External payee: credit the platform clearing's outbound leg (money leaves
    // to the bank; clearing is where it is accounted until settled out).
    legs.push({ creditTo: { kind: 'system', id: SYSTEM.PLATFORM_CLEARING }, amount: BigInt(principal), code: LedgerCode.TX_PRINCIPAL });
  }
  if (commission > 0) {
    legs.push({ creditTo: { kind: 'system', id: SYSTEM.PLATFORM_REVENUE }, amount: BigInt(commission), code: LedgerCode.TX_COMMISSION });
  }

  const { ids: pendingIds, transfers } = await ledger.createPendingSplitChainDetailed({
    transactionId: txId,
    debitFrom: payerAccount,
    legs,
  });

  const imr =
    body.transactionType === 'P2M'
      ? body.internalMerchantReference ?? internalMerchantReference(c.env.PLATFORM_INSTITUTION_CODE ?? '001')
      : null;

  await db.execute(sql`
    INSERT INTO miirra_pay.payment_transactions
      (id, idempotency_key, transaction_type, direction, sender_party_id, receiver_party_id,
       order_id, principal_minor, commission_minor, fee_minor, refundable_minor,
       internal_merchant_reference, tb_ledger_phase, tb_pending_debit_id, tb_pending_credit_ids,
       status, last_event, created_at, updated_at)
    VALUES
      (${txId}, ${idem}, ${body.transactionType}, 'outbound', ${body.sender.partyId ?? null},
       ${body.receiver.partyId ?? null}, ${body.orderId ?? null}, ${body.amountMinor}, ${commission}, 0, 0,
       ${imr}, 'pending', ${idStr(pendingIds[0]!)}, ${JSON.stringify(pendingIds.slice(1).map(idStr))},
       'acknowledged', 'initiate', ${now}, ${now})
  `);

  await persistBindings(db, txId, transfers, 'pending', now);

  const lypay = lypayFromEnv(c.env as never);
  let txn: LypayTransaction;
  try {
    txn = await lypay.initiate({
      transactionType: body.transactionType,
      initiation: {
        amount: { amount: lydToRailString(body.amountMinor), currency: 'lyd' },
        debtorAccount: { schemeName: body.sender.schemeName, identification: body.sender.identification, name: body.sender.name },
        creditorAccount: { schemeName: body.receiver.schemeName, identification: body.receiver.identification, name: body.receiver.name },
        creditorInstitution: body.creditorInstitution,
        additionalData: body.additionalData,
        description: body.description,
        internalMerchantReference: imr ?? undefined,
      },
    });
  } catch (err) {
    // LYPay refused → void the reservation so no balance is held against a
    // transfer that will never settle.
    await voidChain(db, ledger, txId);
    throw err;
  }

  await db.execute(sql`
    UPDATE miirra_pay.payment_transactions
    SET lypay_uuid = ${txn.uuid}, payment_reference = ${txn.paymentReference},
        transaction_timestamp = ${txn.transactionTimestamp}, status = ${statusFromLypay(txn)},
        status_message = ${txn.status.message ?? null}, updated_at = ${Date.now()}
    WHERE id = ${txId}
  `);
  await recordTransition(db, txId, 'acknowledged', 'initiate', txn.paymentReference, now);

  return c.json(
    { id: txId, lypayUuid: txn.uuid, paymentReference: txn.paymentReference, status: statusFromLypay(txn), ledgerPhase: 'pending' },
    201,
  );
});

// ── POST /api/payments/confirm ───────────────────────────────────────────────
paymentsRoute.post('/confirm', requireAuth, async (c) => {
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
  if (!tx) throw notFound('Transaction not found');
  if (!tx.lypay_uuid || !tx.payment_reference) throw conflict('Transaction not yet initiated', 'not_initiated');
  if (tx.status === 'completed') return c.json({ id: tx.id, status: 'completed', alreadyFinal: true });

  const lypay = lypayFromEnv(c.env as never);
  const isMock = c.env.PAYMENTS_MOCK === '1' || !c.env.LYPAY_BASE_URL;
  if (isMock && body.mockPlan) {
    (lypay as unknown as { mockSetConfirmPlan: (u: string, p: string) => void }).mockSetConfirmPlan(tx.lypay_uuid, body.mockPlan);
  }

  const txn = await lypay.confirm(tx.lypay_uuid, {
    paymentReference: tx.payment_reference,
    transactionTimestamp: tx.transaction_timestamp ?? '',
  });
  const status = statusFromLypay(txn);
  const now = Date.now();

  if (status === 'completed') {
    await postChain(db, ledger, tx.id);
    await db.execute(sql`
      UPDATE miirra_pay.payment_transactions
      SET status = 'completed', tb_ledger_phase = 'posted', status_message = ${txn.status.message ?? null},
          finalised_at = ${now}, updated_at = ${now}
      WHERE id = ${tx.id}
    `);
    await recordTransition(db, tx.id, 'completed', 'confirm', txn.paymentReference, now);
    return c.json({ id: tx.id, status: 'completed', ledgerPhase: 'posted' });
  }

  if (status === 'declined') {
    await voidChain(db, ledger, tx.id);
    await db.execute(sql`
      UPDATE miirra_pay.payment_transactions
      SET status = 'declined', tb_ledger_phase = 'voided', status_message = ${txn.status.message ?? 'declined'},
          finalised_at = ${now}, updated_at = ${now}
      WHERE id = ${tx.id}
    `);
    await recordTransition(db, tx.id, 'declined', 'confirm', txn.paymentReference, now);
    return c.json({ id: tx.id, status: 'declined', ledgerPhase: 'voided' });
  }

  // processing / acknowledged → leave pending; the webhook finalises it.
  await db.execute(sql`
    UPDATE miirra_pay.payment_transactions
    SET status = ${status}, status_message = ${txn.status.message ?? null}, updated_at = ${now}
    WHERE id = ${tx.id}
  `);
  await recordTransition(db, tx.id, status, 'confirm', txn.paymentReference, now);
  return c.json({ id: tx.id, status, ledgerPhase: 'pending', note: 'awaiting webhook' });
});

// ── POST /api/payments/refund (M2P) ──────────────────────────────────────────
paymentsRoute.post('/refund', requireAuth, async (c) => {
  const body = parse(RefundSchema, await c.req.json());
  const user = userOf(c);
  const db = getDb(c.env.DATABASE_URL);
  const ledger = ledgerFromEnv(c.env);
  const now = Date.now();

  const idem = `refund:${body.idempotencyKey}`;
  const existing = await db.execute(sql`
    SELECT id, status FROM miirra_pay.payment_transactions WHERE idempotency_key = ${idem} LIMIT 1
  `);
  if (existing.rows.length > 0) {
    const r = existing.rows[0] as { id: string; status: string };
    return c.json({ id: r.id, status: r.status, replayed: true });
  }

  const rows = await db.execute(sql`
    SELECT id, lypay_uuid, payment_reference, transaction_timestamp, status,
           principal_minor, commission_minor, refundable_minor, receiver_party_id
    FROM miirra_pay.payment_transactions WHERE id = ${body.transactionId} LIMIT 1
  `);
  const tx = rows.rows[0] as
    | { id: string; lypay_uuid: string | null; payment_reference: string | null; transaction_timestamp: number | null;
        status: string; principal_minor: number; commission_minor: number; refundable_minor: number; receiver_party_id: string | null }
    | undefined;
  if (!tx) throw notFound('Transaction not found');
  if (tx.status !== 'completed') throw conflict('Can only refund a completed transaction', 'not_refundable');
  if (!tx.lypay_uuid) throw conflict('Transaction has no LYPay reference', 'not_refundable');

  const refundable = tx.refundable_minor > 0 ? tx.refundable_minor : tx.principal_minor;
  if (body.amountMinor > refundable) {
    throw badRequest(`Refund ${body.amountMinor} exceeds refundable ${refundable}`, 'refund_exceeds_balance');
  }

  // M2P returns money to the original payer (the authenticated user). The source
  // is the platform's refund suspense account.
  const refundTxId = uuid();
  const res = await ledger.createPostedRefund({
    transactionId: refundTxId,
    refundFrom: SYSTEM.REFUND_SUSPENSE,
    refundTo: await ledger.ensureAccount('user', user.id),
    principal: BigInt(body.amountMinor),
  });
  const refundIds = res.ids;

  const lypay = lypayFromEnv(c.env as never);
  let txn: LypayTransaction;
  try {
    txn = await lypay.refund(tx.lypay_uuid, {
      payment_reference: tx.payment_reference!,
      transaction_timestamp: tx.transaction_timestamp ?? '',
      amount: lydToRailString(body.amountMinor),
      description: body.description,
    });
  } catch (err) {
    // Ledger posted a refund the rail rejected — a reconciliation event, not a
    // silent swallow. Record the refund row as failed and surface the error.
    await db.execute(sql`
      INSERT INTO miirra_pay.payment_transactions
        (id, idempotency_key, transaction_type, direction, principal_minor, tb_ledger_phase, tb_refund_ids,
         status, last_event, created_at, updated_at)
      VALUES (${refundTxId}, ${idem}, 'M2P', 'refund', ${body.amountMinor}, 'posted', ${JSON.stringify(refundIds.map(idStr))},
              'failed', 'refund', ${now}, ${now})
    `);
    throw err;
  }

  await db.execute(sql`
    INSERT INTO miirra_pay.payment_transactions
      (id, idempotency_key, transaction_type, direction, principal_minor, tb_ledger_phase, tb_refund_ids,
       lypay_uuid, payment_reference, transaction_timestamp, status, last_event, created_at, updated_at)
    VALUES (${refundTxId}, ${idem}, 'M2P', 'refund', ${body.amountMinor}, 'posted', ${JSON.stringify(refundIds.map(idStr))},
            ${txn.uuid}, ${txn.paymentReference}, ${txn.transactionTimestamp}, ${statusFromLypay(txn)}, 'refund', ${now}, ${now})
  `);
  await db.execute(sql`
    UPDATE miirra_pay.payment_transactions
    SET refundable_minor = GREATEST(refundable_minor - ${body.amountMinor}, 0), updated_at = ${now}
    WHERE id = ${tx.id}
  `);
  await recordTransition(db, tx.id, tx.status, 'refund', txn.paymentReference, now, `refunded ${body.amountMinor}`);

  return c.json({ id: refundTxId, status: statusFromLypay(txn), refundedMinor: body.amountMinor, tbRefundIds: refundIds.map(idStr) }, 201);
});

// ── ledger orchestration helpers ─────────────────────────────────────────────

async function persistBindings(
  db: ReturnType<typeof getDb>,
  txId: string,
  transfers: TbTransfer[],
  phase: 'pending' | 'posted' | 'voided',
  now: number,
) {
  for (let i = 0; i < transfers.length; i++) {
    const t = transfers[i]!;
    await db.execute(sql`
      INSERT INTO miirra_pay.ledger_transfer_bindings
        (id, transaction_id, tb_transfer_id, leg, phase, debit_account_id, credit_account_id, amount_minor, code, created_at)
      VALUES (${uuid()}, ${txId}, ${idStr(t.id)}, ${legLabel(i, transfers.length)}, ${phase},
              ${idStr(t.debit_account_id)}, ${idStr(t.credit_account_id)}, ${t.amount.toString()}, ${t.code}, ${now})
      ON CONFLICT (tb_transfer_id) DO NOTHING
    `);
  }
}

function legLabel(index: number, total: number): string {
  if (index === 0) return 'debit';
  return `credit:${index - 1}`;
}

/** Replay the stored pending transfers as the REAL typed objects (full routing). */
async function loadPendingTransfers(db: ReturnType<typeof getDb>, txId: string): Promise<TbTransfer[]> {
  const rows = await db.execute(sql`
    SELECT tb_transfer_id, debit_account_id, credit_account_id, amount_minor, code
    FROM miirra_pay.ledger_transfer_bindings
    WHERE transaction_id = ${txId} AND phase = 'pending'
    ORDER BY leg
  `);
  const out: TbTransfer[] = [];
  for (const r of rows.rows as Array<{ tb_transfer_id: string; debit_account_id: string; credit_account_id: string; amount_minor: number; code: number }>) {
    out.push({
      id: BigInt(r.tb_transfer_id),
      debit_account_id: BigInt(r.debit_account_id),
      credit_account_id: BigInt(r.credit_account_id),
      amount: BigInt(r.amount_minor),
      code: r.code,
      flags: 0,
      ledger: 1,
    });
  }
  return out;
}

async function postChain(db: ReturnType<typeof getDb>, ledger: LedgerService, txId: string) {
  const pending = await loadPendingTransfers(db, txId);
  if (pending.length === 0) return;
  await ledger.postPendingTransfers({ transactionId: txId, pendingTransfers: pending });
  await markBindings(db, txId, 'posted');
}

async function voidChain(db: ReturnType<typeof getDb>, ledger: LedgerService, txId: string) {
  const pending = await loadPendingTransfers(db, txId);
  if (pending.length === 0) return;
  await ledger.voidPendingTransfers({ transactionId: txId, pendingTransfers: pending });
  await markBindings(db, txId, 'voided');
}

async function markBindings(db: ReturnType<typeof getDb>, txId: string, phase: 'posted' | 'voided') {
  await db.execute(sql`
    UPDATE miirra_pay.ledger_transfer_bindings SET phase = ${phase}
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
  detail?: string,
) {
  await db.execute(sql`
    INSERT INTO miirra_pay.payment_state_transitions
      (id, transaction_id, from_status, to_status, trigger, cause_ref, detail, at)
    VALUES (${uuid()}, ${txId}, (SELECT status FROM miirra_pay.payment_transactions WHERE id = ${txId}),
            ${toStatus}, ${trigger}, ${causeRef}, ${detail ?? null}, ${now})
  `);
}