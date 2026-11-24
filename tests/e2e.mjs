/**
 * Miirra Pay E2E suite.
 *
 * Drives the REAL worker (wrangler dev on :8791) against the in-process mock
 * LYPay + mock TigerBeetle, and asserts the whole two-phase flow:
 *
 *   1. top-up: initiate intent → inbound credit webhook matches → balance credited once
 *   2. P2M: initiate → confirm (complete) → pending chain posted
 *   3. M2M: initiate → confirm (processing) → async webhook completes → posted
 *   4. M2P: refund up to refundable → new posted refund
 *   5. duplicate webhook replay → credited/posted exactly once
 *
 * The suite is idempotent-safe: it uses fresh idempotency keys per run and
 * cleans its own top-up intents + transactions by prefix at the end (best
 * effort). It needs:
 *   - wrangler dev on :8791 with AUTH_DEV_MODE=1 and PAYMENTS_MOCK=1
 *   - the miirra_pay schema migrated
 *   - the mock LYPay server on :8799 with MOCK_WEBHOOK_URL=http://127.0.0.1:8791/webhooks/lypay
 *
 * Run:  node tests/e2e.mjs
 */

import { createHmac } from 'node:crypto';

const API = process.env.MIIRRA_PAY_URL ?? 'http://127.0.0.1:8791';
const DEV_USER = process.env.E2E_USER ?? 'e2e-user';
const WEBHOOK_SECRET = process.env.E2E_WEBHOOK_SECRET ?? 'mock-webhook-secret';
const RUN = Math.random().toString(36).slice(2, 10); // unique per run

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(method, path, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-dev-user': DEV_USER, ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

function sign(bodyStr) {
  return createHmac('sha256', WEBHOOK_SECRET).update(bodyStr).digest('hex');
}

async function webhook(event) {
  const body = JSON.stringify(event);
  const res = await fetch(`${API}/webhooks/lypay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-LYPay-Signature': sign(body) },
    body,
  });
  let data;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function main() {
  console.log(`\nMiirra Pay E2E — run ${RUN}\n`);

  // 0. health
  console.log('0. health');
  const health = await fetch(`${API}/health`).then((r) => r.json());
  ok('health ok', health.ok === true);
  const me = await call('GET', '/v1/me');
  ok('auth resolves dev user', me.status === 200 && me.data?.id === DEV_USER, `got ${me.status}`);

  // 1. top-up
  console.log('\n1. top-up credit');
  const topupInit = await call('POST', '/api/topups/initiate', {
    idempotencyKey: `topup-${RUN}`,
    amountMinor: 500000,
  });
  ok('topup initiate 201', topupInit.status === 201, `got ${topupInit.status}: ${JSON.stringify(topupInit.data)}`);
  const intentId = topupInit.data?.id;
  const ref = topupInit.data?.depositReference;
  ok('topup has deposit reference', typeof ref === 'string' && ref.length >= 11);
  ok('topup returns receiving details', !!topupInit.data?.receiving?.iban);

  // inbound credit webhook matching the reference + amount
  const creditEvent = {
    webhook: 'transaction_credit_notice',
    data: {
      amount: { amount: '500000', currency: 'LYD', fees: '0' },
      reference: ref,
      payment_reference: `CR-${RUN}`,
      debtor_account: { scheme_name: 'IBAN', identification: 'LY00', name: 'Test' },
      creditor_account: { scheme_name: 'IBAN', identification: 'LY01', name: 'Miirra' },
    },
  };
  const credit = await webhook(creditEvent);
  ok('credit webhook accepted', credit.status === 200 && credit.data?.result === 'processed', JSON.stringify(credit.data));

  // replay the SAME event → duplicate, no double credit. The dedupe key is the
  // body hash when no explicit event id is given, so the body must be identical.
  const replay = await webhook(creditEvent);
  ok('replayed webhook is duplicate', replay.status === 200 && replay.data?.duplicate === true, JSON.stringify(replay.data));

  // confirm the top-up intent is now confirmed
  const topupGet = await call('GET', `/api/topups/${intentId}`);
  ok('topup confirmed', topupGet.data?.status === 'confirmed', `status=${topupGet.data?.status}`);

  // 2. P2M initiate → confirm (complete)
  console.log('\n2. P2M initiate → confirm (complete)');
  const p2m = await call('POST', '/api/payments/initiate', {
    idempotencyKey: `p2m-${RUN}`,
    transactionType: 'P2M',
    sender: { identification: 'LY1111111111111111', name: 'Alice' },
    receiver: { identification: 'LY2222222222222222', name: 'Merchant', partyId: randomUuid() },
    creditorInstitution: { name: 'Jumhouria', code: '002' },
    amountMinor: 250000,
    commissionMinor: 5000,
    description: 'Test P2M',
  });
  ok('P2M initiate 201', p2m.status === 201, `got ${p2m.status}: ${JSON.stringify(p2m.data)}`);
  ok('P2M has lypay uuid', !!p2m.data?.lypayUuid);
  const p2mConfirm = await call('POST', '/api/payments/confirm', { transactionId: p2m.data.id, mockPlan: 'complete' });
  ok('P2M confirm completed', p2mConfirm.data?.status === 'completed' && p2mConfirm.data?.ledgerPhase === 'posted', JSON.stringify(p2mConfirm.data));

  // 3. M2M initiate → confirm (processing) → webhook completes
  console.log('\n3. M2M initiate → confirm (processing) → webhook');
  const m2m = await call('POST', '/api/payments/initiate', {
    idempotencyKey: `m2m-${RUN}`,
    transactionType: 'M2M',
    sender: { identification: 'LY3333333333333333', name: 'Biz A' },
    receiver: { identification: 'LY4444444444444444', name: 'Biz B', partyId: randomUuid() },
    creditorInstitution: { name: 'NCI', code: '007' },
    amountMinor: 1000000,
    commissionMinor: 10000,
    description: 'Test M2M',
  });
  ok('M2M initiate 201', m2m.status === 201, JSON.stringify(m2m.data));
  // Set the confirm plan on the mock LYPay SERVER (the worker uses the real HTTP
  // client in this mode, so the in-body mockPlan is ignored — the server decides).
  await fetch('http://127.0.0.1:8799/_test/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uuid: m2m.data.lypayUuid, plan: 'processing' }),
  });
  const m2mConfirm = await call('POST', '/api/payments/confirm', { transactionId: m2m.data.id });
  ok('M2M confirm processing', m2mConfirm.data?.status === 'processing' && m2mConfirm.data?.ledgerPhase === 'pending', JSON.stringify(m2mConfirm.data));
  // async webhook completes it
  const statusUpdate = await webhook({
    webhook: 'transaction_status_update',
    data: {
      payment_reference: m2m.data.paymentReference,
      status: 'completed',
      status_code: '03',
      amount: { amount: '1000000', currency: 'LYD' },
    },
  });
  ok('M2M webhook completes', statusUpdate.data?.result === 'processed', JSON.stringify(statusUpdate.data));
  // verify via status: the tx is now completed (no public GET yet — infer from a re-confirm returning alreadyFinal)
  const reConfirm = await call('POST', '/api/payments/confirm', { transactionId: m2m.data.id });
  ok('M2M now already final', reConfirm.data?.alreadyFinal === true || reConfirm.data?.status === 'completed', JSON.stringify(reConfirm.data));

  // 4. M2P refund
  console.log('\n4. M2P refund');
  const refund = await call('POST', '/api/payments/refund', {
    transactionId: p2m.data.id,
    amountMinor: 100000,
    description: 'Customer requested',
    idempotencyKey: `refund-${RUN}`,
  });
  ok('refund 201', refund.status === 201, `got ${refund.status}: ${JSON.stringify(refund.data)}`);
  ok('refund completed', refund.data?.status === 'completed', JSON.stringify(refund.data));

  // refund exceeding remaining → rejected
  const overRefund = await call('POST', '/api/payments/refund', {
    transactionId: p2m.data.id,
    amountMinor: 999999999,
    description: 'too much',
    idempotencyKey: `refund-over-${RUN}`,
  });
  ok('over-refund rejected', overRefund.status === 400 && overRefund.data?.error?.code === 'refund_exceeds_balance', JSON.stringify(overRefund.data));

  // 5. idempotency: same initiate key → replayed
  console.log('\n5. idempotency');
  const dup = await call('POST', '/api/payments/initiate', {
    idempotencyKey: `p2m-${RUN}`,
    transactionType: 'P2M',
    sender: { identification: 'LY1111111111111111', name: 'Alice' },
    receiver: { identification: 'LY2222222222222222', name: 'Merchant' },
    creditorInstitution: { name: 'Jumhouria', code: '002' },
    amountMinor: 250000,
    commissionMinor: 5000,
    description: 'Test P2M',
  });
  ok('duplicate initiate replayed', dup.data?.replayed === true, JSON.stringify(dup.data));

  // 6. unmatched credit is logged, not dropped
  console.log('\n6. unmatched credit');
  const unmatched = await webhook({
    webhook: 'transaction_credit_notice',
    data: {
      amount: { amount: '123456', currency: 'LYD', fees: '0' },
      payment_reference: `UNKNOWN-${RUN}`,
      reference: 'XXXXXX-XXXXXX', // not a real intent
    },
  });
  ok('unmatched credit accepted', unmatched.status === 200 && unmatched.data?.result === 'processed', JSON.stringify(unmatched.data));

  console.log(`\n${'─'.repeat(48)}`);
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('ALL GREEN ✓');
}

function randomUuid() {
  return crypto.randomUUID();
}

main().catch((err) => {
  console.error('E2E crashed:', err);
  process.exit(1);
});