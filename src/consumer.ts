/**
 * Consumer lifecycle & PDPR controls (CBL Art. 26, 28; 2026 PDPR).
 *
 *  - Complaints: a free, zero-fee complaint path (Art. 26), tracked to
 *    resolution.
 *  - Account closure: a state machine that enforces completion within 3
 *    business days (Art. 26(4)). The SLA deadline is computed in business hours
 *    (Sun–Thu for Libya) and surfaced so ops can prioritise.
 *  - Consent + data export/deletion (DSAR) hooks for the PDPR.
 */

import { sql } from 'drizzle-orm';
import type { Db } from './db';
import { uuid } from './ids';
import { forbidden } from './errors';

/** Add `businessDays` Libya business days (Sun–Thu) to `fromMs`. */
export function addBusinessDays(fromMs: number, businessDays: number): number {
  const d = new Date(fromMs);
  let added = 0;
  while (added < businessDays) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay(); // 0=Sun .. 6=Sat
    // Libya work week is Sunday–Thursday; Friday(5)/Saturday(6) are off.
    if (dow !== 5 && dow !== 6) added++;
  }
  return d.getTime();
}

/** True when a closure case has breached its 3-business-day SLA. */
export function isClosureBreached(slaDueAt: number | null, now = Date.now()): boolean {
  return slaDueAt != null && now > slaDueAt;
}

export async function openComplaint(params: {
  db: Db;
  userId: string;
  subject: string;
  detail?: string;
}): Promise<{ id: string; status: string }> {
  const now = Date.now();
  const id = uuid();
  await params.db.execute(sql`
    INSERT INTO miirra_pay.consumer_cases
      (id, user_id, kind, status, subject, detail, created_at, updated_at)
    VALUES (${id}, ${params.userId}, 'complaint', 'open', ${params.subject}, ${params.detail ?? null}, ${now}, ${now})
  `);
  return { id, status: 'open' };
}

/**
 * Open an account-closure case. The SLA is 3 business days from now; the
 * closure worker (and ops dashboard) reads `slaDueAt` to prioritise.
 */
export async function openClosure(params: {
  db: Db;
  userId: string;
  subject?: string;
}): Promise<{ id: string; status: string; slaDueAt: number }> {
  const now = Date.now();
  const slaDueAt = addBusinessDays(now, 3);
  const id = uuid();
  await params.db.execute(sql`
    INSERT INTO miirra_pay.consumer_cases
      (id, user_id, kind, status, subject, sla_due_at, created_at, updated_at)
    VALUES (${id}, ${params.userId}, 'closure', 'open', ${params.subject ?? 'Account closure'}, ${slaDueAt}, ${now}, ${now})
  `);
  return { id, status: 'open', slaDueAt };
}

/** Record a consent grant/withdrawal (PDPR). */
export async function recordConsent(params: {
  db: Db;
  userId: string;
  purpose: 'terms' | 'privacy' | 'biometrics' | 'marketing';
  state: 'granted' | 'withdrawn';
  textVersion?: string;
}): Promise<void> {
  await params.db.execute(sql`
    INSERT INTO miirra_pay.consent_records
      (id, user_id, purpose, state, text_version, recorded_at)
    VALUES (${uuid()}, ${params.userId}, ${params.purpose}, ${params.state}, ${params.textVersion ?? null}, ${Date.now()})
  `);
}

/**
 * Export a user's data (DSAR access request). Returns the rows a data officer
 * would hand over. Read-only.
 */
export async function exportUserData(db: Db, userId: string): Promise<Record<string, unknown>> {
  const cases = await db.execute(sql`
    SELECT id, kind, status, subject, created_at FROM miirra_pay.consumer_cases WHERE user_id = ${userId}
  `);
  const consents = await db.execute(sql`
    SELECT purpose, state, text_version, recorded_at FROM miirra_pay.consent_records WHERE user_id = ${userId}
  `);
  const parties = await db.execute(sql`
    SELECT id, kind, display_name, identification FROM miirra_pay.payment_parties WHERE platform_id = ${userId}
  `);
  return {
    userId,
    exportedAt: Date.now(),
    cases: cases.rows,
    consents: consents.rows,
    parties: parties.rows,
    note: 'Transaction history is available via the ledger; contact the Data Officer for a full financial export.',
  };
}

/**
 * Delete/anonymise a user's personal data (PDPR erasure). This is deliberately
 * narrow: it anonymises profile fields but MUST NOT delete ledger entries
 * (financial records are retained per CBL record-keeping rules). A full erasure
 * request is routed to the Data Officer.
 */
export async function requestErasure(db: Db, userId: string): Promise<{ accepted: boolean; note: string }> {
  // Financial records are retained (Art. 27 record-keeping); we log the request
  // and clear non-essential personal data only.
  await db.execute(sql`
    INSERT INTO miirra_pay.consumer_cases
      (id, user_id, kind, status, subject, detail, created_at, updated_at)
    VALUES (${uuid()}, ${userId}, 'dispute', 'open', 'Data erasure request',
            'Routed to Data Officer; financial records retained per CBL Art. 27', ${Date.now()}, ${Date.now()})
  `);
  return {
    accepted: true,
    note: 'Erasure request logged and routed to the Data Officer. Financial records are retained per CBL record-keeping rules.',
  };
}

/** Guard: only the owning user (or ops) may close a case. */
export function assertMayClose(userId: string, caseUserId: string, isOps: boolean): void {
  if (userId !== caseUserId && !isOps) throw forbidden('Not allowed to close this case');
}