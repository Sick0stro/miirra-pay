// Seed test accounts with starting balances via the dev faucet.
// Requires the worker running with AUTH_DEV_MODE=1 (see .dev.vars).
//
//   node scripts/seed-test-accounts.mjs            # default set
//   BASE=http://127.0.0.1:8791 node scripts/seed-test-accounts.mjs
//
// Idempotent-ish: each run mints MORE balance (a faucet), so run once on a
// fresh DB, or pass FRESH=1 to top everyone up again for a clean demo.
const BASE = process.env.BASE || 'http://127.0.0.1:8791';

// The demo cast. `id` is what you type into the wallet's "Dev user id" field.
const ACCOUNTS = [
  { id: 'test-alice', amountMinor: 125000, label: 'Alice — everyday wallet' }, // 1,250.000 LYD
  { id: 'test-bob', amountMinor: 34050, label: 'Bob — small balance' }, // 340.500
  { id: 'test-carol', amountMinor: 500000, label: 'Carol — high balance' }, // 5,000.000
  { id: 'test-dina', amountMinor: 7525, label: 'Dina — low balance' }, // 75.250
];

async function faucet(userId, amountMinor) {
  const r = await fetch(BASE + '/api/dev/faucet', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, amountMinor }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${userId}: ${r.status} ${JSON.stringify(j)}`);
  return j;
}

console.log('Seeding test accounts via', BASE, '\n');
let ok = 0;
for (const a of ACCOUNTS) {
  try {
    const j = await faucet(a.id, a.amountMinor);
    ok++;
    console.log(`  \u2713 ${a.id.padEnd(12)} +${(a.amountMinor / 1000).toFixed(3)} LYD  → balance ${(j.availableMinor / 1000).toFixed(3)} LYD   (${a.label})`);
  } catch (e) {
    console.error(`  \u2717 ${a.id}: ${e.message}`);
  }
}

console.log(`\n${ok}/${ACCOUNTS.length} accounts funded.`);
console.log('\nSign in at ' + BASE + '/app  →  enter a "Dev user id":');
for (const a of ACCOUNTS) console.log('   ' + a.id.padEnd(12) + a.label);
process.exit(ok === ACCOUNTS.length ? 0 : 1);