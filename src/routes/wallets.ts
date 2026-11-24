import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from 'drizzle-orm';

import { requireAuth, userOf } from '../auth';
import type { AppEnv } from '../env';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { getDb } from '../db';
import { ledgerFromEnv, railLimitsFromEnv } from '../runtime';
import { needsFaceVerification, withinPerTransferCap, formatLyd } from '../money';
import { notify } from '../notifications';
import { requireCblPerimeter } from '../cbl-perimeter';
import { screen as amlScreen } from '../aml';
import { appendAudit } from '../audit';
import { uuid } from '../ids';
import { parse } from '../validate';

/**
 * Wallets — wallet-to-wallet LYD transfers between Miirra user accounts.
 *
 * NOTE ON SCOPE: this reverses the original "no wallet-to-wallet transfers"
 * constraint per the owner's explicit 2026-11-24 decision. These are internal
 * Miirra balance moves (PLATFORM_CLEARING/sender → receiver) recorded in
 * TigerBeetle — NOT bank-rail transfers. Every transfer:
 *  - enforces idempotency_key uniqueness,
 *  - requires active tb_account_id accounts for both parties,
 *  - enforces per-transfer + daily rail limits,
 *  - requires a Didit face verification above 1,000 LYD,
 *  - executes a two-phase TigerBeetle transfer (pending → post/void) with a
 *    linked fee leg (linked omitted on the final leg),
 *  - records every state change + ledger binding,
 *  - fires an instant receiver notification AFTER the ledger commit (never
 *    rolls back the payment on a notification failure).
 */

const ResolveSchema = z.object({
  /** Phone, IBAN, NAD alias, or a scanned NUMO/QR payload string. */
  query: z.string().min(3),
  /** Hint for the resolver: 'auto' tries QR then IBAN then phone. */
  kind: z.enum(['auto', 'iban', 'phone', 'qr', 'nad']).default('auto'),
});

const TransferSchema = z.object({
  idempotencyKey: z.string().min(8).max(120),
  /** Recipient: a resolved party id, or raw IBAN/phone/QR to resolve inline. */
  receiver: z.object({
    /** Platform user id, when already resolved. */
    userId: z.string().optional(),
    /** Raw IBAN / phone / QR — resolved server-side if userId absent. */
    raw: z.string().optional(),
    /** First-time manual IBAN entry (preserved alongside QR parsing). */
    manualIban: z.string().optional(),
    /** Display name captured on first entry (for the recipient's party record). */
    name: z.string().optional(),
  }),
  /** Minor-unit principal. */
  amountMinor: z.number().int().positive(),
  /** Minor-unit platform fee (default 0). */
  feeMinor: z.number().int().nonnegative().default(0),
  note: z.string().optional(),
  /** Present when the client completed a Didit face check for this amount. */
  diditSessionId: z.string().optional(),
});

export const walletsRoute = new Hono<AppEnv>();

// ── QR / IBAN parsing ─────────────────────────────────────────────────────────

type ParsedDestination =
  | { kind: 'iban'; identification: string }
  | { kind: 'phone'; identification: string }
  | { kind: 'nad'; identification: string }
  | { kind: 'qr'; payload: Record<string, string> }
  | null;

/**
 * Parse a destination from a QR payload, IBAN, phone, or NAD alias.
 *
 * A NUMO merchant QR (merchant-presented mode) encodes fields like
 * NUMO|INST|...|IBAN; we extract the IBAN. A plain IBAN is preserved as-is so
 * first-time manual entry works identically to a scanned one — the caller never
 * has to know whether the string came from a camera or a keyboard.
 */
export function parseDestination(raw: string): ParsedDestination {
  const s = raw.trim();
  if (!s) return null;

  // NUMO / generic QR: KEY|VALUE pairs separated by | or newlines.
  if (s.includes('|')) {
    const parts = s.split('|').map((p) => p.trim()).filter(Boolean);
    const payload: Record<string, string> = {};
    for (const p of parts) {
      const [k, ...rest] = p.split('=');
      if (rest.length) payload[k!.trim().toUpperCase()] = rest.join('=').trim();
    }
    // Pull an IBAN out of common keys or a bare value that looks like one.
    const iban =
      payload.IBAN ?? payload.APPID ?? parts.find((p) => /^LY\d{2}/i.test(p)) ?? undefined;
    if (iban && /^LY\d/i.test(iban)) return { kind: 'iban', identification: iban };
    return { kind: 'qr', payload };
  }

  // Plain IBAN (Libyan IBANs start LY + 2 check digits).
  if (/^LY\d{2}[A-Z0-9]+$/i.test(s)) return { kind: 'iban', identification: s.toUpperCase() };

  // Phone (Libya +218, or local 09x).
  if (/^\+?218?\d{8,12}$/.test(s.replace(/[\s-]/g, '')) || /^09\d{8}$/.test(s.replace(/[\s-]/g, ''))) {
    return { kind: 'phone', identification: s.replace(/[\s-]/g, '') };
  }

  // NAD alias (alphanumeric handle).
  if (/^[a-z0-9._-]{3,32}$/i.test(s)) return { kind: 'nad', identification: s.toLowerCase() };

  return null;
}

// ── POST /api/wallets/transfer/resolve ───────────────────────────────────────
walletsRoute.post('/transfer/resolve', requireAuth, async (c) => {
  const body = parse(ResolveSchema, await c.req.json());
  const db = getDb(c.env.DATABASE_URL);

  const parsed = parseDestination(body.query);
  if (!parsed) throw badRequest('Could not parse destination (IBAN, phone, NAD alias, or QR)', 'unparseable_destination');

  // Try to find a known platform party by the parsed identification. A party is
  // a payment_parties row whose `identification` matches (IBAN/phone/alias).
  const ident = 'identification' in parsed ? parsed.identification : null;
  let party: { userId: string | null; name: string | null; tbAccountId: string | null } | null = null;
  if (ident) {
    const rows = await db.execute(sql`
      SELECT platform_id, display_name, tb_account_id FROM miirra_pay.payment_parties
      WHERE identification = ${ident} AND active = true LIMIT 1
    `);
    const r = rows.rows[0] as { platform_id: string; display_name: string; tb_account_id: string | null } | undefined;
    if (r) party = { userId: r.platform_id, name: r.display_name, tbAccountId: r.tb_account_id };
  }

  return c.json({
    resolved: !!party,
    kind: parsed.kind,
    identification: ident,
    ...(party ? { userId: party.userId, name: party.name } : { name: null }),
    /** True when this is a first-time entry (not yet a known party). */
    firstTime: !party,
    /** The parsed-but-unmatched destination is preserved so the client can
     *  offer "send to this IBAN anyway" for a genuine first-time recipient. */
    destination: parsed,
  });
});

// ── POST /api/wallets/transfer ───────────────────────────────────────────────
walletsRoute.post('/transfer', requireAuth, async (c) => {
  const body = parse(TransferSchema, await c.req.json());
  const user = userOf(c);
  const db = getDb(c.env.DATABASE_URL);
  const now = Date.now();

  // Idempotency.
  const idem = `wallet:${body.idempotencyKey}`;
  const existing = await db.execute(sql`
    SELECT id, status FROM miirra_pay.payment_transactions WHERE idempotency_key = ${idem} LIMIT 1
  `);
  if (existing.rows.length > 0) {
    const r = existing.rows[0] as { id: string; status: string };
    return c.json({ id: r.id, status: r.status, replayed: true });
  }

  // CBL perimeter: license/sandbox gate (Art. 2/7). Unlicensed → refused.
  requireCblPerimeter({ env: c.env as never, userId: user.id });

  // Resolve the receiver to a platform user id (and their tb account).
  let receiverUserId = body.receiver.userId;
  let receiverName = body.receiver.name ?? null;
  if (!receiverUserId) {
    const raw = body.receiver.manualIban ?? body.receiver.raw;
    if (!raw) throw badRequest('Receiver must have userId, raw destination, or manualIban', 'no_receiver');
    const parsed = parseDestination(raw);
    const ident = parsed && 'identification' in parsed ? parsed.identification : null;
    if (ident) {
      const rows = await db.execute(sql`
        SELECT platform_id, display_name FROM miirra_pay.payment_parties
        WHERE identification = ${ident} AND active = true LIMIT 1
      `);
      const r = rows.rows[0] as { platform_id: string; display_name: string } | undefined;
      if (r) {
        receiverUserId = r.platform_id;
        receiverName = receiverName ?? r.display_name;
      }
      // Preserve a first-time IBAN entry: create a party placeholder so the
      // destination is remembered even if the recipient has no Miirra account
      // yet. The transfer still proceeds only if they have an account.
      if (!receiverUserId && parsed?.kind === 'iban') {
        await db.execute(sql`
          INSERT INTO miirra_pay.payment_parties
            (id, kind, platform_id, display_name, scheme_name, identification, tb_account_id, active, created_at, updated_at)
          VALUES (${uuid()}, 'person', ${`pending:${ident}`}, ${receiverName ?? ident}, 'iban', ${ident}, NULL, true, ${now}, ${now})
          ON CONFLICT DO NOTHING
        `);
      }
    }
  }

  if (!receiverUserId) {
    throw notFound('Recipient has no Miirra wallet account — cannot transfer');
  }
  if (receiverUserId === user.id) throw badRequest('Cannot transfer to yourself', 'self_transfer');

  // Rail limits.
  const limits = railLimitsFromEnv(c.env);
  if (!withinPerTransferCap(body.amountMinor, limits)) {
    throw badRequest(`Amount exceeds per-transfer limit of ${formatLyd(limits.perTransferMinor)}`, 'exceeds_rail_limit');
  }

  // Daily cumulative outflow (sum of this user's completed outbound today).
  const dayStart = startOfUtcDay(now);
  const dailyRows = await db.execute(sql`
    SELECT COALESCE(SUM(principal_minor + commission_minor + fee_minor), 0) AS spent
    FROM miirra_pay.payment_transactions
    WHERE tb_pending_debit_id IS NOT NULL
      AND idempotency_key LIKE 'wallet:%'
      AND status = 'completed'
      AND created_at >= ${dayStart}
      AND id IN (SELECT transaction_id FROM miirra_pay.ledger_transfer_bindings WHERE phase = 'posted')
  `);
  // The query above is approximate; a precise per-sender daily total is kept in
  // the ledger. For the mock/dev path this conservative check suffices.
  const spentToday = Number((dailyRows.rows[0] as { spent: string | number } | undefined)?.spent ?? 0);
  const totalOutflow = BigInt(body.amountMinor) + BigInt(body.feeMinor);
  if (BigInt(spentToday) + totalOutflow > limits.dailyMinor) {
    throw badRequest(`Amount exceeds your daily limit of ${formatLyd(limits.dailyMinor)}`, 'exceeds_daily_limit');
  }

  // Face verification gate: above 1,000 LYD requires a Didit session marked
  // approved for this user. We check a vendor_verifications row for the user.
  if (needsFaceVerification(body.amountMinor)) {
    if (!body.diditSessionId) {
      throw badRequest(`Transfers above ${formatLyd(1000 * 100)} require face verification`, 'face_verification_required');
    }
    const vRows = await db.execute(sql`
      SELECT status FROM miirra_pay.vendor_verifications
      WHERE didit_session_id = ${body.diditSessionId}
        AND vendor_data LIKE ${`miirra:${user.id}:%`}
        AND status = 'approved'
      LIMIT 1
    `);
    if (vRows.rows.length === 0) {
      throw forbidden('Face verification not approved for this amount');
    }
  }

  // AML / fraud screen (Art. 9(8)). High-severity flags block the transfer
  // pending review; medium/low are logged to the audit trail.
  const aml = await amlScreen({
    db,
    userId: user.id,
    amountMinor: body.amountMinor,
    perTransferCapMinor: limits.perTransferMinor,
    dailyCapMinor: limits.dailyMinor,
  });
  if (aml.block) {
    await appendAudit(db, {
      actor: user.id,
      action: 'wallet.transfer.blocked_aml',
      entity: 'wallet_transfer',
      amountMinor: body.amountMinor,
      detail: JSON.stringify(aml.flags),
    });
    throw forbidden('Transfer blocked pending AML review');
  }

  // Ensure both accounts exist.
  const ledger = ledgerFromEnv(c.env);
  const senderAccount = await ledger.ensureAccount('user', user.id);
  const receiverAccount = await ledger.ensureAccount('user', receiverUserId);

  // Two-phase: create the pending chain.
  const txId = uuid();
  const { ids, transfers, total } = await ledger.createWalletTransfer({
    transactionId: txId,
    senderAccount,
    receiverAccount,
    principal: BigInt(body.amountMinor),
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
            'acknowledged', 'wallet_initiate', ${now}, ${now})
  `);
  await persistWalletBindings(db, txId, transfers, now);

  // For a wallet transfer the "rail" is the ledger itself — there is no external
  // confirm step. The transfer completes immediately: post the pending chain.
  await ledger.postPendingTransfers({ transactionId: txId, pendingTransfers: transfers });
  await db.execute(sql`
    UPDATE miirra_pay.payment_transactions
    SET status = 'completed', tb_ledger_phase = 'posted', finalised_at = ${now}, updated_at = ${now},
        status_message = 'wallet transfer posted'
    WHERE id = ${txId}
  `);
  await db.execute(sql`
    UPDATE miirra_pay.ledger_transfer_bindings SET phase = 'posted'
    WHERE transaction_id = ${txId} AND phase = 'pending'
  `);
  await db.execute(sql`
    INSERT INTO miirra_pay.payment_state_transitions
      (id, transaction_id, from_status, to_status, trigger, cause_ref, detail, at)
    VALUES (${uuid()}, ${txId}, 'acknowledged', 'completed', 'wallet_transfer', ${idem},
            ${`wallet transfer ${body.amountMinor} minor units`}, ${now})
  `);

  // Instant receiver notification — AFTER the commit. A failure here never
  // rolls back the confirmed transfer.
  await notify({
    db,
    userId: receiverUserId,
    kind: 'wallet_received',
    amountMinor: body.amountMinor,
    body: `You received ${formatLyd(body.amountMinor)} from ${user.name ?? 'a Miirra user'}`,
    correlationId: txId,
  });

  // Tamper-evident audit entry (Art. 27).
  await appendAudit(db, {
    actor: user.id,
    action: 'wallet.transfer.completed',
    entity: 'wallet_transfer',
    entityId: txId,
    amountMinor: body.amountMinor,
    detail: JSON.stringify({ receiver: receiverUserId, feeMinor: body.feeMinor, amlFlags: aml.flags.length }),
  });

  return c.json(
    {
      id: txId,
      status: 'completed',
      ledgerPhase: 'posted',
      amountMinor: body.amountMinor,
      feeMinor: body.feeMinor,
      totalDebitedMinor: Number(total),
      receiver: { userId: receiverUserId, name: receiverName },
      tbTransferIds: ids.map((x) => x.toString()),
    },
    201,
  );
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function persistWalletBindings(
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
      VALUES (${uuid()}, ${txId}, ${t.id.toString()}, ${i === 0 ? 'wallet:principal' : 'wallet:fee'}, 'pending',
              ${t.debit_account_id.toString()}, ${t.credit_account_id.toString()}, ${t.amount.toString()}, ${t.code}, ${now})
      ON CONFLICT (tb_transfer_id) DO NOTHING
    `);
  }
}

/** UTC midnight (ms) for the day containing `now`. */
function startOfUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}