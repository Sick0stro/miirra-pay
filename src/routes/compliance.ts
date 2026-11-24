import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from 'drizzle-orm';

import { requireAuth, userOf } from '../auth';
import type { AppEnv } from '../env';
import { badRequest } from '../errors';
import { getDb } from '../db';
import { parse } from '../validate';
import { openComplaint, openClosure, recordConsent, exportUserData, requestErasure } from '../consumer';
import { appendAudit, verifyAuditChain } from '../audit';
import { reconcileLedger } from '../reconciliation';

/**
 * Compliance — consumer lifecycle (Art. 26, 28), PDPR consent/export/erasure,
 * tamper-evident audit verification (Art. 27), and ledger reconciliation
 * (Art. 14/15). Read + self-serve actions for the owning user; audit-verify and
 * recon are ops-facing (gated by staff elsewhere in a real deployment — here
 * they require auth and are read-only).
 */

const ComplaintSchema = z.object({ subject: z.string().min(1), detail: z.string().optional() });
const ConsentSchema = z.object({
  purpose: z.enum(['terms', 'privacy', 'biometrics', 'marketing']),
  state: z.enum(['granted', 'withdrawn']),
  textVersion: z.string().optional(),
});

export const complianceRoute = new Hono<AppEnv>();

// ── Consumer lifecycle ────────────────────────────────────────────────────────
complianceRoute.post('/complaints', requireAuth, async (c) => {
  const user = userOf(c);
  const body = parse(ComplaintSchema, await c.req.json());
  const db = getDb(c.env.DATABASE_URL);
  const res = await openComplaint({ db, userId: user.id, subject: body.subject, detail: body.detail });
  await appendAudit(db, { actor: user.id, action: 'complaint.opened', entity: 'consumer_case', entityId: res.id });
  return c.json(res, 201);
});

complianceRoute.post('/account/closure', requireAuth, async (c) => {
  const user = userOf(c);
  const db = getDb(c.env.DATABASE_URL);
  const res = await openClosure({ db, userId: user.id });
  await appendAudit(db, { actor: user.id, action: 'account.closure_requested', entity: 'consumer_case', entityId: res.id });
  return c.json(res, 201);
});

// ── PDPR consent + DSAR ────────────────────────────────────────────────────────
complianceRoute.post('/consent', requireAuth, async (c) => {
  const user = userOf(c);
  const body = parse(ConsentSchema, await c.req.json());
  const db = getDb(c.env.DATABASE_URL);
  await recordConsent({ db, userId: user.id, purpose: body.purpose, state: body.state, textVersion: body.textVersion });
  return c.json({ ok: true });
});

complianceRoute.get('/data/export', requireAuth, async (c) => {
  const user = userOf(c);
  const db = getDb(c.env.DATABASE_URL);
  const data = await exportUserData(db, user.id);
  await appendAudit(db, { actor: user.id, action: 'data.export_requested', entity: 'user', entityId: user.id });
  return c.json(data);
});

complianceRoute.post('/data/erasure', requireAuth, async (c) => {
  const user = userOf(c);
  const db = getDb(c.env.DATABASE_URL);
  const res = await requestErasure(db, user.id);
  await appendAudit(db, { actor: user.id, action: 'data.erasure_requested', entity: 'user', entityId: user.id });
  return c.json(res);
});

// ── Audit verification (Art. 27) ───────────────────────────────────────────────
complianceRoute.get('/audit/verify', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const res = await verifyAuditChain(db);
  return c.json(res, res.ok ? 200 : 500);
});

// ── Ledger reconciliation (Art. 14/15) ─────────────────────────────────────────
complianceRoute.get('/reconciliation', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  // All active user wallet account ids.
  const rows = await db.execute(sql`
    SELECT tb_account_id FROM miirra_pay.payment_parties WHERE tb_account_id IS NOT NULL AND active = true
  `);
  const ids = (rows.rows as Array<{ tb_account_id: string }>)
    .map((r) => BigInt(r.tb_account_id))
    .filter((x) => x >= 0n);
  // In mock mode the per-request ledger can't sum across users; return a
  // structural ok with a note rather than a false gap.
  const { createLedgerClient } = await import('../ledger');
  const useHttp = c.env.LEDGER_MODE === 'http' || !!c.env.LEDGER_BRIDGE_URL;
  if (!useHttp) {
    return c.json({ ok: true, mode: 'mock', note: 'mock ledger: reconciliation requires the real bridge', checkedAt: Date.now() });
  }
  const tb = createLedgerClient({ baseUrl: c.env.LEDGER_BRIDGE_URL!, token: c.env.LEDGER_BRIDGE_TOKEN ?? '', mode: 'http' });
  const res = await reconcileLedger({ tb, userAccountIds: ids });
  return c.json(res, res.ok ? 200 : 500);
});