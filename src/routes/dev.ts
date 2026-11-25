import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from 'drizzle-orm';

import type { AppEnv } from '../env';
import { getDb } from '../db';
import { forbidden } from '../errors';
import { uuid } from '../ids';
import { parse } from '../validate';
import { accountIdFor, transferIdFor, SYSTEM } from '../ledger-codes';
import { LedgerCode } from '../ledger-service';
import { appendAudit } from '../audit';

/**
 * DEV-ONLY helpers. The whole router is gated behind AUTH_DEV_MODE=1 and
 * returns 403 the moment it is unset — so it can never exist in production.
 *
 * `POST /api/dev/faucet` mints a starting balance for a test account so the
 * wallet front end has something to show. It writes the SAME records a real
 * credit writes — a posted ledger binding (PLATFORM_CLEARING → user), the
 * transaction row, a state transition and an audit entry — so the balance and
 * the activity feed are real projections of the ledger, not a fake number the
 * UI invents. This is a convenience for local testing only.
 */
export const devRoute = new Hono<AppEnv>();

// Fail closed: nothing in this router works unless dev mode is explicitly on.
devRoute.use('*', async (c, next) => {
  if ((c.env.AUTH_DEV_MODE as string | undefined) !== '1') {
    throw forbidden('Dev endpoints are disabled');
  }
  await next();
});

const FaucetSchema = z.object({
  userId: z.string().min(1),
  amountMinor: z.number().int().positive(),
});

devRoute.post('/faucet', async (c) => {
  const body = parse(FaucetSchema, await c.req.json());
  const db = getDb(c.env.DATABASE_URL);
  const now = Date.now();
  const txId = uuid();
  const accountIdStr = accountIdFor('user', body.userId).toString();
  const transferId = transferIdFor(txId, 'faucet:credit').toString();
  const idem = `faucet:${body.userId}:${now}`;

  await db.execute(sql`
    INSERT INTO miirra_pay.payment_transactions
      (id, idempotency_key, transaction_type, direction, principal_minor, commission_minor, fee_minor,
       refundable_minor, tb_ledger_phase, status, last_event, created_at, updated_at, finalised_at)
    VALUES (${txId}, ${idem}, 'P2P', 'outbound', ${body.amountMinor}, 0, 0,
            0, 'posted', 'completed', 'faucet', ${now}, ${now}, ${now})
  `);
  await db.execute(sql`
    INSERT INTO miirra_pay.ledger_transfer_bindings
      (id, transaction_id, tb_transfer_id, leg, phase, debit_account_id, credit_account_id, amount_minor, code, created_at)
    VALUES (${uuid()}, ${txId}, ${transferId}, 'faucet:credit', 'posted',
            ${SYSTEM.PLATFORM_CLEARING.toString()}, ${accountIdStr}, ${body.amountMinor}, ${LedgerCode.TX_TOPUP}, ${now})
    ON CONFLICT (tb_transfer_id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO miirra_pay.payment_state_transitions
      (id, transaction_id, from_status, to_status, trigger, cause_ref, detail, at)
    VALUES (${uuid()}, ${txId}, 'acknowledged', 'completed', 'faucet', ${idem},
            ${`dev faucet ${body.amountMinor} minor units`}, ${now})
  `);
  await appendAudit(db, {
    actor: 'dev:faucet',
    action: 'dev.faucet.credit',
    entity: 'wallet_faucet',
    entityId: txId,
    amountMinor: body.amountMinor,
    detail: JSON.stringify({ userId: body.userId }),
  });

  // Return the new projected balance (same formula the balance endpoint uses).
  const bal = await db.execute(sql`
    SELECT
      COALESCE(SUM(CASE WHEN credit_account_id = ${accountIdStr} THEN amount_minor ELSE 0 END), 0) AS credits,
      COALESCE(SUM(CASE WHEN debit_account_id  = ${accountIdStr} THEN amount_minor ELSE 0 END), 0) AS debits
    FROM miirra_pay.ledger_transfer_bindings
    WHERE phase = 'posted' AND (credit_account_id = ${accountIdStr} OR debit_account_id = ${accountIdStr})
  `);
  const b = (bal.rows[0] ?? {}) as Record<string, string | number>;
  const availableMinor = Number(b.credits ?? 0) - Number(b.debits ?? 0);

  return c.json({ userId: body.userId, creditedMinor: body.amountMinor, availableMinor }, 201);
});