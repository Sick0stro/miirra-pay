/**
 * Mock LYPay server — a standalone HTTP stand-in for the CBL LYPay API v1, used
 * by the E2E suite when you want to exercise the REAL HTTP client path
 * (lypay.ts with mode:'http') instead of the in-process mock.
 *
 * It implements the verified v1 shapes: auth/token, funds-transfers (initiate),
 * confirm, refund, status, and emits webhooks to a configurable callback URL so
 * the suite can drive the full asynchronous flow (initiate → confirm → webhook).
 *
 * Run:  node tests/mock-lypay.mjs           (listens on :8799)
 * Env:  MOCK_LYPAY_PORT   default 8799
 *       MOCK_WEBHOOK_URL  where to POST webhooks (your worker's /webhooks/lypay)
 *       MOCK_WEBHOOK_SECRET  HMAC secret (must match the worker's)
 *
 * Behaviour knobs (so tests can force each branch):
 *   - confirm plan per tx, set via POST /_test/plan { uuid, plan }
 *       plan: 'complete' | 'decline' | 'processing'
 *   - when plan is 'processing', the confirm returns processing and the server
 *     delivers a transaction_status_update webhook after a short delay.
 */

import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';

const PORT = Number(process.env.MOCK_LYPAY_PORT ?? 8799);
const WEBHOOK_URL = process.env.MOCK_WEBHOOK_URL ?? '';
const WEBHOOK_SECRET = process.env.MOCK_WEBHOOK_SECRET ?? 'mock-webhook-secret';

/** In-memory transaction store. */
const txns = new Map();
/** confirm plan per uuid: complete | decline | processing */
const plans = new Map();

function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(s);
}

function sign(bodyStr) {
  return createHmac('sha256', WEBHOOK_SECRET).update(bodyStr).digest('hex');
}

async function deliverWebhook(event) {
  if (!WEBHOOK_URL) return;
  const bodyStr = JSON.stringify(event);
  const sig = sign(bodyStr);
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-LYPay-Signature': sig },
      body: bodyStr,
    });
  } catch (err) {
    console.error('[mock-lypay] webhook delivery failed:', err?.message ?? err);
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const now = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();
const ts = (ms) => Math.floor(ms / 1000);

function buildTransaction({ uuid, pr, type, amount, debtor, creditor, inst, imr, desc, status }) {
  const t = now();
  return {
    uuid,
    paymentReference: pr,
    status,
    transactionDateTime: iso(t),
    transactionTimestamp: ts(t),
    valueDateTime: iso(t),
    transactionType: type,
    debtorAmount: { currency: 'lyd', amount: String(amount), fees: '0' },
    creditorAmount: { currency: 'lyd', amount: String(amount), fees: '0' },
    debtorAccount: debtor,
    creditorAccount: creditor,
    creditorInstitution: inst,
    additionalData: {},
    numoNotice: { debit: {}, credit: {}, reverse: [] },
    internalMerchantReference: imr,
    description: desc,
    refund: { isRefunded: false, transactions: [] },
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  // ── test control ──────────────────────────────────────────────────────────
  if (path === '/_test/plan' && req.method === 'POST') {
    const b = await readBody(req);
    plans.set(b.uuid, b.plan ?? 'complete');
    return json(res, 200, { ok: true, uuid: b.uuid, plan: b.plan });
  }
  if (path === '/_test/reset' && req.method === 'POST') {
    txns.clear();
    plans.clear();
    return json(res, 200, { ok: true });
  }
  if (path === '/_test/state' && req.method === 'GET') {
    return json(res, 200, { txns: [...txns.values()] });
  }

  // ── auth ─────────────────────────────────────────────────────────────────
  if (path === '/api/v1/auth/token' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.email || !b.password) {
      return json(res, 401, { error: { code: 'AUT-003', message: 'Invalid credentials.', errors: [] } });
    }
    return json(res, 200, {
      data: { token: { name: 'mock', value: `mock-token-${Date.now()}`, expiration_date: '2099-12-31' } },
    });
  }

  // ── reference ─────────────────────────────────────────────────────────────
  if (path === '/api/v1/miscs/transaction-status' && req.method === 'GET') {
    return json(res, 200, {
      date: [
        { name: 'acknowledged', code: '01' },
        { name: 'processing', code: '02' },
        { name: 'completed', code: '03' },
        { name: 'declined', code: '04' },
      ],
    });
  }

  // ── initiate ───────────────────────────────────────────────────────────────
  if (path === '/api/v1/payments/funds-transfers' && req.method === 'POST') {
    const b = await readBody(req);
    const init = b.initiation ?? {};
    const uuid = randomUUID();
    const pr = randomUUID();
    const txn = buildTransaction({
      uuid,
      pr,
      type: b.transactionType ?? 'P2P',
      amount: init.amount?.amount ?? '0',
      debtor: init.debtorAccount ?? {},
      creditor: init.creditorAccount ?? {},
      inst: init.creditorInstitution ?? {},
      imr: init.internalMerchantReference,
      desc: init.description ?? '',
      status: { name: 'acknowledged', code: '01', message: 'SWITCH ACK' },
    });
    txns.set(uuid, txn);
    return json(res, 201, { data: txn });
  }

  // ── confirm ────────────────────────────────────────────────────────────────
  if (/^\/api\/v1\/payments\/funds-transfers\/[^/]+\/confirm$/.test(path) && req.method === 'POST') {
    const uuid = decodeURIComponent(path.split('/')[5]);
    const b = await readBody(req);
    void b;
    const txn = txns.get(uuid);
    if (!txn) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'unknown transaction' } });
    const plan = plans.get(uuid) ?? 'complete';
    if (plan === 'decline') {
      txn.status = { name: 'declined', code: '04', message: 'MOCK DECLINE' };
      return json(res, 201, { data: txn });
    }
    if (plan === 'processing') {
      txn.status = { name: 'processing', code: '02', message: 'MOCK PROCESSING' };
      // async: later flip to completed + deliver a webhook.
      setTimeout(async () => {
        txn.status = { name: 'completed', code: '03', message: 'MOCK COMPLETED' };
        await deliverWebhook({
          webhook: 'transaction_status_update',
          data: {
            payment_reference: txn.paymentReference,
            status: 'completed',
            status_code: '03',
            amount: txn.debtorAmount,
          },
        });
      }, 300);
      return json(res, 201, { data: txn });
    }
    txn.status = { name: 'completed', code: '03', message: 'MOCK COMPLETED' };
    return json(res, 201, { data: txn });
  }

  // ── status ─────────────────────────────────────────────────────────────────
  if (/^\/api\/v1\/payments\/funds-transfers\/[^/]+$/.test(path) && req.method === 'GET') {
    const uuid = decodeURIComponent(path.split('/')[5]);
    const txn = txns.get(uuid);
    if (!txn) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'unknown transaction' } });
    return json(res, 200, { data: txn });
  }

  // ── refund ─────────────────────────────────────────────────────────────────
  if (/^\/api\/v1\/payments\/funds-transfers\/[^/]+\/refund$/.test(path) && req.method === 'POST') {
    const uuid = decodeURIComponent(path.split('/')[5]);
    const b = await readBody(req);
    const orig = txns.get(uuid);
    if (!orig) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'unknown transaction' } });
    const refundUuid = randomUUID();
    const txn = buildTransaction({
      uuid: refundUuid,
      pr: randomUUID(),
      type: 'M2P',
      amount: b.amount ?? '0',
      debtor: orig.creditorAccount,
      creditor: orig.debtorAccount,
      inst: orig.creditorInstitution,
      desc: b.description ?? '',
      status: { name: 'completed', code: '03', message: 'MOCK REFUND COMPLETED' },
    });
    txn.refund = { isRefunded: true, transactions: [] };
    txns.set(refundUuid, txn);
    return json(res, 200, { data: txn });
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `no route ${req.method} ${path}` } }));
});

server.listen(PORT, () => {
  console.log(`[mock-lypay] listening on http://127.0.0.1:${PORT}`);
  if (WEBHOOK_URL) console.log(`[mock-lypay] delivering webhooks to ${WEBHOOK_URL}`);
  else console.log('[mock-lypay] no MOCK_WEBHOOK_URL set — webhooks will not be delivered');
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));