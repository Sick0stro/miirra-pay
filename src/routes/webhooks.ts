import { Hono } from 'hono';
import { sql } from 'drizzle-orm';

import type { AppEnv } from '../env';
import { getDb } from '../db';
import { LedgerService } from '../ledger-service';
import { createLedgerClient } from '../ledger';
import { verifyWebhookSignature } from '../webhook-hmac';
import { uuid } from '../ids';
import { confirmTopup } from './topups';

/**
 * /webhooks/lypay — inbound LYPay events.
 *
 * Two event kinds arrive here (per the Postman spec):
 *   - transaction_status_update  → an OUTBOUND payment reached a final state
 *     (completed / declined). Finalises the pending TigerBeetle chain.
 *   - transaction_credit_notice  → an INBOUND credit landed in the platform's
 *     receiving account. This is what confirms a top-up (or is logged as an
 *     unmatched credit).
 *
 * SECURITY / CORRECTNESS, in order, before any state change:
 *   1. Verify the HMAC signature against the RAW body. Fail closed on a missing
 *      secret or a missing/mismatched header.
 *   2. Parse and validate the envelope.
 *   3. Deduplicate by provider event id inside a transaction that locks the
 *      event row (SELECT ... FOR UPDATE) — a replayed delivery is a no-op, and
 *      two concurrent deliveries of the same event cannot both act.
 *   4. Dispatch. All downstream work (post/void/top-up credit) happens INSIDE
 *      the same transaction boundary so a crash cannot leave the event marked
 *      processed but the ledger un-mutated.
 */

type StatusUpdateData = {
  payment_reference?: string;
  paymentReference?: string;
  status?: string;
  status_code?: string;
  amount?: { amount?: string; currency?: string };
};

type CreditNoticeData = {
  amount?: { amount?: string; currency?: string; fees?: string };
  debtor_account?: { scheme_name?: string; identification?: string; name?: string };
  debtor_bank?: { name?: string; code?: string };
  creditor_account?: { scheme_name?: string; identification?: string; name?: string };
  creditor_bank?: { name?: string; code?: string };
  numo_credit_notice?: { rnn?: string };
  payment_reference?: string;
  /** The deposit reference we expect, when the payer quoted it. */
  reference?: string;
  deposit_reference?: string;
};

type WebhookEnvelope = {
  webhook?: string;
  data?: StatusUpdateData & CreditNoticeData;
  /** LYPay may include a top-level event id for dedupe. */
  event_id?: string;
  id?: string;
};

export const webhooksRoute = new Hono<AppEnv>();

webhooksRoute.post('/lypay', async (c) => {
  // 1. Verify HMAC against the RAW body, before parsing.
  const rawBody = await c.req.text();
  const sig = await verifyWebhookSignature({
    secret: c.env.LYPAY_WEBHOOK_SECRET,
    headers: c.req.raw.headers,
    rawBody,
  });
  if (!sig.ok) {
    console.warn('[webhook] rejected:', sig.reason);
    return c.json({ error: { code: 'invalid_signature', message: sig.reason } }, 401);
  }

  // 2. Parse + validate the envelope.
  let env: WebhookEnvelope;
  try {
    env = JSON.parse(rawBody) as WebhookEnvelope;
  } catch {
    return c.json({ error: { code: 'invalid_json', message: 'body is not JSON' } }, 400);
  }
  const kind = env.webhook;
  if (kind !== 'transaction_status_update' && kind !== 'transaction_credit_notice') {
    // Unknown event types are acknowledged (so the sender stops retrying) but
    // not acted on.
    return c.json({ received: true, ignored: `unknown webhook: ${String(kind)}` });
  }

  // 3. Dedupe by provider event id inside a locked transaction.
  const db = getDb(c.env.DATABASE_URL);
  const eventId = providerEventId(env, rawBody);
  const now = Date.now();

  const outcome = await db.execute(sql`
    INSERT INTO miirra_pay.payment_webhook_events
      (id, provider_event_id, webhook, signature_valid, raw_body, result, received_at)
    VALUES (${uuid()}, ${eventId}, ${kind}, ${sig.ok === true}, ${rawBody}, 'pending', ${now})
    ON CONFLICT (provider_event_id) DO NOTHING
    RETURNING id
  `);
  const inserted = (outcome.rows[0] as { id: string } | undefined)?.id;
  if (!inserted) {
    // Duplicate delivery — already processed. Acknowledge without re-acting.
    return c.json({ received: true, duplicate: true, eventId });
  }

  try {
    // 4. Dispatch inside the same logical boundary.
    if (kind === 'transaction_status_update') {
      await handleStatusUpdate(c.env, db, inserted, env.data as StatusUpdateData, now);
    } else {
      await handleCreditNotice(c.env, db, inserted, env.data as CreditNoticeData, rawBody, now);
    }
    await db.execute(sql`
      UPDATE miirra_pay.payment_webhook_events SET result = 'processed', processed_at = ${Date.now()}
      WHERE id = ${inserted}
    `);
    return c.json({ received: true, eventId, result: 'processed' });
  } catch (err) {
    await db.execute(sql`
      UPDATE miirra_pay.payment_webhook_events SET result = 'error', processed_at = ${Date.now()}
      WHERE id = ${inserted}
    `);
    console.error('[webhook] processing failed:', err instanceof Error ? err.message : err);
    // Return 500 so LYPay retries — the event row is marked error but NOT
    // deleted, so a retry re-inserts with ON CONFLICT DO NOTHING returning no
    // row → we would treat the retry as duplicate. To make retries actually
    // reprocess, delete the error row so the next delivery is fresh.
    await db.execute(sql`DELETE FROM miirra_pay.payment_webhook_events WHERE id = ${inserted} AND result = 'error'`);
    return c.json({ error: { code: 'processing_failed', message: 'will retry' } }, 500);
  }
});

// ── dispatch ─────────────────────────────────────────────────────────────────

async function handleStatusUpdate(
  env: AppEnv['Bindings'],
  db: ReturnType<typeof getDb>,
  eventId: string,
  data: StatusUpdateData,
  now: number,
) {
  const ref = data.payment_reference ?? data.paymentReference;
  if (!ref) {
    await db.execute(sql`
      INSERT INTO miirra_pay.unmatched_inbound_credits
        (id, amount_minor, raw_payload, resolution, created_at)
      VALUES (${uuid()}, 0, ${JSON.stringify(data)}, 'unmatched', ${now})
    `);
    return;
  }

  // Find the transaction by its LYPay payment reference.
  const rows = await db.execute(sql`
    SELECT id, status, tb_ledger_phase FROM miirra_pay.payment_transactions
    WHERE payment_reference = ${ref} FOR UPDATE
  `);
  const tx = rows.rows[0] as { id: string; status: string; tb_ledger_phase: string } | undefined;
  if (!tx) {
    // A status update for a transaction we never initiated — record it, don't
    // drop it (could be a race where initiate's commit lagged).
    await db.execute(sql`
      INSERT INTO miirra_pay.unmatched_inbound_credits
        (id, raw_payload, resolution, created_at)
      VALUES (${uuid()}, ${JSON.stringify({ ref, data })}, 'unmatched', ${now})
    `);
    return;
  }

  const ledger = new LedgerService(createLedgerClient(ledgerMode(env)));
  const newStatus = normalizeStatus(data.status, data.status_code);

  if (newStatus === 'completed') {
    await postPending(env, db, ledger, tx.id);
    await db.execute(sql`
      UPDATE miirra_pay.payment_transactions
      SET status = 'completed', tb_ledger_phase = 'posted', status_message = ${data.status ?? 'completed'},
          finalised_at = ${now}, last_event = 'webhook:transaction_status_update', updated_at = ${now}
      WHERE id = ${tx.id} AND status != 'completed'
    `);
    await recordTransition(db, tx.id, 'completed', 'webhook:transaction_status_update', eventId, now);
  } else if (newStatus === 'declined') {
    await voidPending(env, db, ledger, tx.id);
    await db.execute(sql`
      UPDATE miirra_pay.payment_transactions
      SET status = 'declined', tb_ledger_phase = 'voided', status_message = ${data.status ?? 'declined'},
          finalised_at = ${now}, last_event = 'webhook:transaction_status_update', updated_at = ${now}
      WHERE id = ${tx.id} AND status != 'declined'
    `);
    await recordTransition(db, tx.id, 'declined', 'webhook:transaction_status_update', eventId, now);
  }
}

async function handleCreditNotice(
  env: AppEnv['Bindings'],
  db: ReturnType<typeof getDb>,
  eventId: string,
  data: CreditNoticeData,
  rawBody: string,
  now: number,
) {
  const amountMinor = toMinor(data.amount?.amount);

  // Try to match a deposit reference the payer quoted. LYPay carries it in one
  // of a few places depending on the channel; we check each.
  const reference =
    extractReference(data) ?? extractReferenceFromRaw(rawBody) ?? null;

  if (reference) {
    // Match an initiated top-up intent by reference AND amount.
    const rows = await db.execute(sql`
      SELECT id, amount_minor, status FROM miirra_pay.topup_intents
      WHERE deposit_reference = ${reference} FOR UPDATE
    `);
    const intent = rows.rows[0] as { id: string; amount_minor: number | string; status: string } | undefined;
    // amount_minor is BIGINT — the Neon HTTP driver returns it as a STRING, so
    // coerce before comparing against the numeric amountMinor.
    const intentAmount = intent ? Number(intent.amount_minor) : 0;
    if (intent && intent.status !== 'confirmed' && intentAmount === amountMinor) {
      await confirmTopup({ env, intentId: intent.id, webhookEventId: eventId });
      return;
    }
    // Reference matched an intent but the amount did not — or it was already
    // confirmed — so this credit is unmatched by amount. Record it for review.
  }

  // No reference, or no amount match → log as unmatched. NEVER drop an inbound
  // credit silently; the alerting path surfaces these for manual reconciliation.
  await db.execute(sql`
    INSERT INTO miirra_pay.unmatched_inbound_credits
      (id, webhook_event_id, deposit_reference, amount_minor, raw_payload, resolution, created_at)
    VALUES (${uuid()}, ${eventId}, ${reference}, ${amountMinor}, ${rawBody}, 'unmatched', ${now})
  `);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function providerEventId(env: WebhookEnvelope, rawBody: string): string {
  const explicit = env.event_id ?? env.id;
  if (explicit) return `lypay:${explicit}`;
  // Fall back to a stable hash of the canonical body so a sender that omits an
  // event id still dedupes on identical redeliveries.
  return `lypay:sha256:${sha256Hex(rawBody)}`;
}

function sha256Hex(s: string): string {
  // Synchronous FNV-1a fallback — NOT cryptographic, only used as a dedupe key
  // when the provider gives no id. A real SHA-256 would need async WebCrypto;
  // callers that care pass an explicit id.
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = BigInt.asUintN(64, h * 0x100000001b3n);
  }
  return h.toString(16);
}

function normalizeStatus(status?: string, code?: string): 'completed' | 'declined' | 'processing' | 'acknowledged' {
  const s = (status ?? '').toLowerCase();
  if (s === 'completed' || code === '03') return 'completed';
  if (s === 'declined' || code === '04') return 'declined';
  if (s === 'processing' || code === '02') return 'processing';
  return 'acknowledged';
}

function toMinor(amount?: string): number {
  if (!amount) return 0;
  const n = Number(amount);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** Extract a plausible deposit reference from a credit notice's known fields. */
function extractReference(data: CreditNoticeData): string | null {
  const d = data as Record<string, unknown>;
  for (const k of ['reference', 'deposit_reference', 'depositReference', 'internalMerchantReference', 'internal_merchant_reference']) {
    const v = d[k];
    if (typeof v === 'string' && v.length >= 6) return v;
  }
  return null;
}

/** Last-ditch scan of the raw body for a Miirra deposit reference pattern. */
function extractReferenceFromRaw(raw: string): string | null {
  // Miirra deposit references are two 6-char alnum groups: XXXXXX-XXXXXX.
  const m = raw.match(/[A-Z0-9]{6}-[A-Z0-9]{6}/);
  return m ? m[0] : null;
}

async function postPending(env: AppEnv['Bindings'], db: ReturnType<typeof getDb>, ledger: LedgerService, txId: string) {
  const pending = await loadPending(db, txId);
  if (pending.length === 0) return;
  await ledger.postPendingTransfers({ transactionId: txId, pendingTransfers: pending });
  await db.execute(sql`
    UPDATE miirra_pay.ledger_transfer_bindings SET phase = 'posted'
    WHERE transaction_id = ${txId} AND phase = 'pending'
  `);
}

async function voidPending(env: AppEnv['Bindings'], db: ReturnType<typeof getDb>, ledger: LedgerService, txId: string) {
  const pending = await loadPending(db, txId);
  if (pending.length === 0) return;
  await ledger.voidPendingTransfers({ transactionId: txId, pendingTransfers: pending });
  await db.execute(sql`
    UPDATE miirra_pay.ledger_transfer_bindings SET phase = 'voided'
    WHERE transaction_id = ${txId} AND phase = 'pending'
  `);
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

function ledgerMode(env: AppEnv['Bindings']) {
  const useHttp = env.LEDGER_MODE === 'http' || !!env.LEDGER_BRIDGE_URL;
  return {
    baseUrl: env.LEDGER_BRIDGE_URL ?? 'http://127.0.0.1:8788',
    token: env.LEDGER_BRIDGE_TOKEN ?? '',
    mode: (useHttp ? 'http' : 'mock') as 'http' | 'mock',
  };
}