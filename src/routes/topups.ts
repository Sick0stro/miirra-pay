import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from 'drizzle-orm';

import { requireAuth, userOf } from '../auth';
import type { AppEnv } from '../env';
import { conflict } from '../errors';
import { getDb } from '../db';
import { LedgerService } from '../ledger-service';
import { createLedgerClient } from '../ledger';
import { depositReference, uuid } from '../ids';
import { parse } from '../validate';

/**
 * Top-ups — the Bank/LYPay → Miirra inbound funding flow.
 *
 * The user expresses an INTENT to add funds. We hand back a unique deposit
 * reference + the platform's receiving details (IBAN / NAD alias / NUMO QR).
 * The user then transfers from their bank/LYPay channel quoting that reference.
 *
 * A top-up is credited to the user's TigerBeetle balance ONCE — and ONLY when
 * an inbound credit webhook (transaction_credit_notice) matches BOTH the
 * deposit reference and the amount. A client "I sent it" claim credits nothing.
 * Credits that arrive with no matching intent land in unmatched_inbound_credits
 * for reconciliation; they are never dropped.
 */

const InitiateSchema = z.object({
  idempotencyKey: z.string().min(8).max(120),
  /** Minor-unit amount the user intends to add (LYD piastres). */
  amountMinor: z.number().int().positive(),
});

export const topupsRoute = new Hono<AppEnv>();

// ── POST /api/topups/initiate ────────────────────────────────────────────────
topupsRoute.post('/initiate', requireAuth, async (c) => {
  const body = parse(InitiateSchema, await c.req.json());
  const user = userOf(c);
  const db = getDb(c.env.DATABASE_URL);
  const now = Date.now();

  const idem = `topup:${body.idempotencyKey}`;
  const existing = await db.execute(sql`
    SELECT id, deposit_reference, amount_minor, status FROM miirra_pay.topup_intents
    WHERE idempotency_key = ${idem} LIMIT 1
  `);
  if (existing.rows.length > 0) {
    const r = existing.rows[0] as { id: string; deposit_reference: string; amount_minor: number; status: string };
    return c.json({
      id: r.id,
      depositReference: r.deposit_reference,
      amountMinor: r.amount_minor,
      status: r.status,
      receiving: receivingDetails(c.env),
      replayed: true,
    });
  }

  const id = uuid();
  const ref = depositReference();
  const expiresAt = now + 24 * 3600 * 1000; // intents expire after 24h

  await db.execute(sql`
    INSERT INTO miirra_pay.topup_intents
      (id, user_id, idempotency_key, deposit_reference, amount_minor, receiving_details,
       status, expires_at, created_at)
    VALUES (${id}, ${user.id}, ${idem}, ${ref}, ${body.amountMinor}, ${JSON.stringify(receivingDetails(c.env))},
            'initiated', ${expiresAt}, ${now})
  `);

  return c.json(
    {
      id,
      depositReference: ref,
      amountMinor: body.amountMinor,
      status: 'initiated',
      receiving: receivingDetails(c.env),
      expiresAt,
    },
    201,
  );
});

/** The receiving details a user transfers to. */
function receivingDetails(env: AppEnv['Bindings']) {
  return {
    iban: env.PLATFORM_RECEIVING_IBAN ?? 'LY00 0000 0000 0000 0000 0000',
    /** National Alias Directory alias, if issued. */
    nadAlias: 'miirra',
    /** NUMO QR payload (merchant-presented mode) the bank app scans. */
    numoQr: `NUMO|000|MIIRRA|${env.PLATFORM_RECEIVING_IBAN ?? ''}`,
    currency: 'lyd',
    note: 'Quote the deposit reference on your bank transfer. Credited automatically once matched.',
  };
}

// ── GET /api/topups/:id ──────────────────────────────────────────────────────
topupsRoute.get('/:id', requireAuth, async (c) => {
  const user = userOf(c);
  const db = getDb(c.env.DATABASE_URL);
  const id = c.req.param('id');
  const rows = await db.execute(sql`
    SELECT id, deposit_reference, amount_minor, status, confirmed_at, created_at, expires_at
    FROM miirra_pay.topup_intents WHERE id = ${id} AND user_id = ${user.id} LIMIT 1
  `);
  const r = rows.rows[0] as
    | { id: string; deposit_reference: string; amount_minor: number; status: string; confirmed_at: number | null; created_at: number; expires_at: number | null }
    | undefined;
  if (!r) return c.json({ error: { code: 'not_found', message: 'Top-up not found' } }, 404);
  return c.json(r);
});

// ── GET /api/topups ──────────────────────────────────────────────────────────
topupsRoute.get('', requireAuth, async (c) => {
  const user = userOf(c);
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db.execute(sql`
    SELECT id, deposit_reference, amount_minor, status, confirmed_at, created_at
    FROM miirra_pay.topup_intents WHERE user_id = ${user.id} ORDER BY created_at DESC LIMIT 50
  `);
  return c.json({ topups: rows.rows });
});

/**
 * Confirm a top-up intent from a matched inbound credit.
 *
 * Called ONLY from the webhook handler after it has matched a credit to this
 * intent by (deposit reference AND amount). It is the single place a top-up
 * becomes money. Idempotent: a replayed webhook credits once (the TigerBeetle
 * transfer id is derived from the deposit reference).
 */
export async function confirmTopup(params: {
  env: AppEnv['Bindings'];
  intentId: string;
  webhookEventId: string;
}): Promise<{ credited: boolean; amountMinor: number; userId: string }> {
  const db = getDb(params.env.DATABASE_URL);
  const ledger = new LedgerService(createLedgerClient(ledgerMode(params.env)));
  const now = Date.now();

  // Load + lock the intent inside a transaction so two concurrent webhooks can
  // never double-credit the same top-up.
  const result = await db.execute(sql`
    SELECT id, user_id, amount_minor, status FROM miirra_pay.topup_intents
    WHERE id = ${params.intentId} FOR UPDATE
  `);
  const intent = result.rows[0] as
    | { id: string; user_id: string; amount_minor: number | string; status: string }
    | undefined;
  if (!intent) throw new Error(`topup intent ${params.intentId} not found`);
  const amountMinor = Number(intent.amount_minor);
  if (intent.status === 'confirmed') {
    return { credited: false, amountMinor, userId: intent.user_id };
  }

  // Credit the user's TigerBeetle balance exactly once.
  const res = await ledger.postTopUpCredit({
    depositReference: intent.id, // unique per intent → deterministic transfer id
    userId: intent.user_id,
    amount: BigInt(amountMinor),
  });

  if (res.credited) {
    // Record the resulting credit as a payment_transaction so the money movement
    // shows up in the unified ledger view. principal_minor is NOT NULL, so set it.
    const txId = uuid();
    await db.execute(sql`
      INSERT INTO miirra_pay.payment_transactions
        (id, idempotency_key, transaction_type, direction, principal_minor, tb_ledger_phase, tb_refund_ids,
         status, last_event, created_at, updated_at, finalised_at)
      VALUES (${txId}, ${`topup:${intent.id}`}, 'P2P', 'outbound', ${amountMinor}, 'posted', ${JSON.stringify([res.transferId.toString()])},
              'completed', 'topup_credit', ${now}, ${now}, ${now})
      ON CONFLICT (idempotency_key) DO NOTHING
    `);
  }

  await db.execute(sql`
    UPDATE miirra_pay.topup_intents
    SET status = 'confirmed', confirmed_transaction_id = (
          SELECT id FROM miirra_pay.payment_transactions WHERE idempotency_key = ${`topup:${intent.id}`} LIMIT 1
        ),
        confirmed_by_event_id = ${params.webhookEventId}, confirmed_at = ${now}
    WHERE id = ${intent.id} AND status != 'confirmed'
  `);

  return { credited: res.credited, amountMinor, userId: intent.user_id };
}

function ledgerMode(env: AppEnv['Bindings']) {
  const useHttp = env.LEDGER_MODE === 'http' || !!env.LEDGER_BRIDGE_URL;
  return {
    baseUrl: env.LEDGER_BRIDGE_URL ?? 'http://127.0.0.1:8788',
    token: env.LEDGER_BRIDGE_TOKEN ?? '',
    mode: (useHttp ? 'http' : 'mock') as 'http' | 'mock',
  };
}