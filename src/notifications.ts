/**
 * Instant notifications — best-effort, never blocks or rolls back a confirmed
 * payment.
 *
 * When a wallet transfer POSTS, the receiver should be notified immediately. A
 * notification failure must NEVER roll back the confirmed ledger state — money
 * has already moved. So every notify() call:
 *  - runs AFTER the ledger commit,
 *  - swallows its own errors (logging them with a status for a retry worker),
 *  - records an attempt row so a background job can retry delivery.
 *
 * Delivery itself is pluggable (push, SMS, WS). In dev/mock it logs; in prod it
 * would call FCM/APNs/WS. The DB row is the source of truth for "was the user
 * told?", independent of whether the transport succeeded.
 */

import { sql } from 'drizzle-orm';
import type { Db } from './db';
import { uuid } from './ids';

export type NotificationKind = 'wallet_received' | 'payment_confirmed' | 'topup_confirmed';

export type NotifyParams = {
  db: Db;
  userId: string;
  kind: NotificationKind;
  /** Minor-unit amount, if money moved. */
  amountMinor?: number;
  /** Free-text context (e.g. "from Alice"). */
  body?: string;
  /** Correlation id (transaction id). */
  correlationId?: string;
};

/**
 * Fire-and-forget notification. Returns the attempt result but NEVER throws —
 * callers do not (and must not) branch on failure to undo a payment.
 */
export async function notify(params: NotifyParams): Promise<{ attempted: boolean; delivered: boolean; error?: string }> {
  const { db, userId, kind, amountMinor, body, correlationId } = params;
  const id = uuid();
  const now = Date.now();
  try {
    // Record the attempt first so a retry worker can see it even if transport
    // throws synchronously below.
    await db.execute(sql`
      INSERT INTO miirra_pay.notification_attempts
        (id, user_id, kind, amount_minor, body, correlation_id, status, attempts, created_at, updated_at)
      VALUES (${id}, ${userId}, ${kind}, ${amountMinor ?? 0}, ${body ?? null}, ${correlationId ?? null},
              'pending', 1, ${now}, ${now})
    `);
    // Transport would go here (push/SMS/WS). Mock: mark delivered.
    await db.execute(sql`
      UPDATE miirra_pay.notification_attempts SET status = 'delivered', delivered_at = ${now}, updated_at = ${now}
      WHERE id = ${id}
    `);
    return { attempted: true, delivered: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[notify] failed (does not roll back payment):', msg);
    // Best effort: try to mark failed. If even this fails, the log line is the
    // last resort — the payment is already committed and correct.
    try {
      await db.execute(sql`
        UPDATE miirra_pay.notification_attempts SET status = 'failed', last_error = ${msg}, updated_at = ${Date.now()}
        WHERE id = ${id}
      `);
    } catch {
      /* swallow — notification must never affect payment state */
    }
    return { attempted: true, delivered: false, error: msg };
  }
}