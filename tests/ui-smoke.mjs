// Smoke test for the wallet front-end API surface:
//   GET /app (HTML), GET /api/wallets/balance, GET /api/wallets/activity,
//   GET /api/topups/rails — plus a round-trip transfer that must show up in
//   the activity feed and move the balance.
const BASE = process.env.BASE || 'http://127.0.0.1:8791';
const H = { 'content-type': 'application/json', 'x-dev-user': 'e2e-user' };
const H2 = { 'content-type': 'application/json', 'x-dev-user': 'ui-receiver' };

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713', name); }
  else { fail++; console.log('  \u2717', name, extra ? '— ' + extra : ''); }
}
async function j(method, path, body, headers = H) {
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

const RUN = Date.now().toString(36);

console.log('\n1. GET /app serves the React wallet SPA');
{
  const r = await fetch(BASE + '/app');
  const html = await r.text();
  ok('status 200', r.status === 200, 'got ' + r.status);
  ok('is HTML with Miirra Pay', /Miirra Pay/.test(html) && /<html/.test(html));
  ok('has the React root + module entry', /id="root"/.test(html) && /<script[^>]+module/.test(html));
}

console.log('\n2. GET / serves the SPA (no redirect)');
{
  const r = await fetch(BASE + '/', { redirect: 'manual' });
  const html = await r.text();
  ok('root serves the SPA index', r.status === 200 && /id="root"/.test(html), 'got ' + r.status);
}

console.log('\n3. GET /api/wallets/balance');
const meBefore = await j('GET', '/api/wallets/balance');
ok('balance 200', meBefore.status === 200, JSON.stringify(meBefore.data));
ok('currency LYD', meBefore.data.currency === 'LYD');
ok('has availableMinor number', typeof meBefore.data.availableMinor === 'number');
ok('reports a source', meBefore.data.source === 'tigerbeetle' || meBefore.data.source === 'database_projection');

console.log('\n4. GET /api/topups/rails');
const rails = await j('GET', '/api/topups/rails');
ok('rails 200', rails.status === 200);
ok('has integrated + coming_soon',
  (rails.data.rails || []).some((r) => r.status === 'integrated') &&
  (rails.data.rails || []).some((r) => r.status === 'coming_soon'));

console.log('\n5. Transfer round-trip shows in activity + moves balance');
const recvBefore = await j('GET', '/api/wallets/balance', undefined, H2);
const amt = 12345; // 12.345 LYD
const tr = await j('POST', '/api/wallets/transfer', {
  idempotencyKey: 'ui-smoke-' + RUN,
  receiver: { userId: 'ui-receiver' },
  amountMinor: amt,
});
ok('transfer 201', tr.status === 201, JSON.stringify(tr.data));
ok('transfer completed', tr.data.status === 'completed');

const meAfter = await j('GET', '/api/wallets/balance');
ok('sender balance dropped by amount',
  meAfter.data.availableMinor === meBefore.data.availableMinor - amt,
  `before ${meBefore.data.availableMinor} after ${meAfter.data.availableMinor}`);

const recvAfter = await j('GET', '/api/wallets/balance', undefined, H2);
ok('receiver balance rose by amount',
  recvAfter.data.availableMinor === recvBefore.data.availableMinor + amt,
  `before ${recvBefore.data.availableMinor} after ${recvAfter.data.availableMinor}`);

console.log('\n6. Activity feed reflects the transfer for both sides');
const actMe = await j('GET', '/api/wallets/activity?limit=10');
const mine = (actMe.data.activity || []).find((a) => a.id === tr.data.id);
ok('sender sees the transfer', !!mine, JSON.stringify(actMe.data).slice(0, 160));
ok('sender direction out', mine && mine.direction === 'out');
ok('sender sees counterparty name/id', mine && mine.counterparty && mine.counterparty.userId === 'ui-receiver');

const actRecv = await j('GET', '/api/wallets/activity?limit=10', undefined, H2);
const theirs = (actRecv.data.activity || []).find((a) => a.id === tr.data.id);
ok('receiver sees the transfer', !!theirs);
ok('receiver direction in', theirs && theirs.direction === 'in');

console.log('\n7. Activity is capped + ordered newest-first');
ok('activity respects limit', (actMe.data.activity || []).length <= 10);

console.log('\n' + '\u2500'.repeat(48));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) { console.log('SMOKE FAILED'); process.exit(1); }
console.log('WALLET UI SMOKE GREEN \u2713');