import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';

import type { AppEnv } from './env';
import { ApiError } from './errors';
import { requireAuth } from './auth';
import { userOf } from './auth';
import { paymentsRoute } from './routes/payments';
import { topupsRoute } from './routes/topups';
import { webhooksRoute } from './routes/webhooks';
import { verificationsRoute } from './routes/verifications';
import { diditWebhooksRoute } from './routes/didit-webhooks';
import { walletsRoute } from './routes/wallets';
import { withdrawalsRoute } from './routes/withdrawals';
import { healthRoute } from './routes/health';

/**
 * Miirra Pay — the LYD payments worker.
 *
 * Its own worker (not mounted inside miirra-api) so a payments incident is
 * isolated and its deploy cadence is independent. It shares the Neon cluster
 * (its tables live in the `miirra_pay` schema) and the same Better Auth sessions
 * for identity, but owns the LYPay rail and the TigerBeetle bridge binding.
 *
 * Routes:
 *   POST /api/topups/initiate      initiate a top-up intent → deposit reference
 *   GET  /api/topups               list my top-ups
 *   GET  /api/topups/:id           one top-up
 *   POST /api/payments/initiate    P2P / P2M / M2M initiate (two-phase)
 *   POST /api/payments/confirm     confirm an initiated transfer
 *   POST /api/payments/refund      M2P refund
 *   POST /webhooks/lypay           LYPay inbound events (HMAC-verified)
 *   GET  /health                   liveness
 */

const app = new Hono<AppEnv>();

// CORS: every Miirra client is first-party and authenticates with a bearer
// token, so allowing all origins is safe (same stance as miirra-api).
app.use('*', cors());

// Error shaping: every failure → { error: { code, message } }.
app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status as never);
  }
  if (err instanceof HTTPException) {
    return c.json({ error: { code: 'http_error', message: err.message } }, err.status);
  }
  console.error('[miirra-pay] unhandled:', err instanceof Error ? err.stack ?? err.message : err);
  return c.json({ error: { code: 'internal', message: 'Internal error' } }, 500);
});

// Dependency-aware health (NeonDB + TigerBeetle bridge), no secret exposure.
app.route('/', healthRoute);

// Who am I — proves the auth path works and gives the client its user id.
app.get('/v1/me', requireAuth, (c) => {
  const u = userOf(c);
  return c.json({ id: u.id, email: u.email, name: u.name });
});

// The webhook routes are mounted at the TOP level (not under /api) because the
// providers call the exact path they were configured with.
app.route('/webhooks', webhooksRoute); // LYPay (CBL)
app.route('/webhooks', diditWebhooksRoute); // Didit (KYC/KYB) → /webhooks/didit

// API routes.
app.route('/api/topups', topupsRoute);
app.route('/api/payments', paymentsRoute);
app.route('/api/verifications', verificationsRoute);
app.route('/api/wallets', walletsRoute);
app.route('/api/withdrawals', withdrawalsRoute);

export default app;