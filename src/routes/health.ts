import { Hono } from 'hono';
import { sql } from 'drizzle-orm';

import type { AppEnv } from '../env';
import { getDb } from '../db';
import { createLedgerClient } from '../ledger';

/**
 * Health — liveness + dependency readiness, with NO secret exposure.
 *
 * GET /health returns a small JSON verdict:
 *  - ok: overall (200 when all critical deps are reachable, 503 otherwise)
 *  - checks.neon: can we run a trivial query against Postgres?
 *  - checks.ledger: is the TigerBeetle bridge reachable (or is mock mode on)?
 *
 * It NEVER echoes a connection string, token, or any binding value — only
 * booleans and short latency numbers. This is safe to expose to load balancers
 * and uptime monitors.
 */
export const healthRoute = new Hono<AppEnv>();

healthRoute.get('/health', async (c) => {
  const started = Date.now();
  const checks: Record<string, { ok: boolean; ms?: number; mode?: string; error?: string }> = {};

  // 1. NeonDB connectivity — a trivial SELECT 1.
  try {
    const db = getDb(c.env.DATABASE_URL);
    const t0 = Date.now();
    await db.execute(sql`SELECT 1`);
    checks.neon = { ok: true, ms: Date.now() - t0 };
  } catch (err) {
    checks.neon = { ok: false, error: 'unreachable' };
  }

  // 2. TigerBeetle bridge reachability (mock mode is trivially healthy).
  const useHttp = c.env.LEDGER_MODE === 'http' || !!c.env.LEDGER_BRIDGE_URL;
  if (!useHttp) {
    checks.ledger = { ok: true, mode: 'mock' };
  } else {
    try {
      const client = createLedgerClient({
        baseUrl: c.env.LEDGER_BRIDGE_URL ?? 'http://127.0.0.1:8788',
        token: c.env.LEDGER_BRIDGE_TOKEN ?? '',
        mode: 'http',
      });
      const t0 = Date.now();
      const ok = await client.health();
      checks.ledger = { ok, ms: Date.now() - t0, mode: 'http' };
    } catch (err) {
      checks.ledger = { ok: false, mode: 'http', error: 'unreachable' };
    }
  }

  const ok = checks.neon?.ok === true && checks.ledger?.ok === true;
  return c.json(
    { ok, service: 'miirra-pay', ts: Date.now(), uptimeMs: Date.now() - started, checks },
    ok ? 200 : 503,
  );
});