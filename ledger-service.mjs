/**
 * TigerBeetle bridge service — the ONE place native code lives.
 *
 * The Worker (src/) cannot load native addons or open raw sockets, so it never
 * talks to TigerBeetle directly. This small Node service owns the real
 * `tigerbeetle-node` Client and exposes the authenticated HTTP surface the
 * Worker's `src/ledger.ts` calls:
 *
 *   POST /v1/accounts/create   { accounts: WireAccount[] }  → TbItemResult[]
 *   POST /v1/transfers/create  { transfers: WireTransfer[] } → TbItemResult[]
 *   POST /v1/accounts/lookup   { ids: string[] }             → balances[]
 *   POST /v1/health            {}                            → { ok: true }
 *
 * Wire types match src/ledger.ts exactly (u128 ids + amounts as decimal
 * strings, because JSON has no safe integer past 2^53).
 *
 * Deploy this where a native addon CAN run (a VM / Fly.io / a container next to
 * the TigerBeetle cluster). It holds the cluster address + the bridge bearer
 * token; the Worker holds only the token. The token never reaches a browser.
 *
 * Run:  node ledger-service.ts       (needs `tigerbeetle-node` + a cluster)
 * Env:  TIGERBEETLE_ADDRESS  cluster address (default 127.0.0.1:3000)
 *       BRIDGE_PORT          listen port      (default 8788)
 *       BRIDGE_TOKEN         bearer token     (required in prod)
 */

import { createServer } from 'node:http';

// `tigerbeetle-node` is the native addon this service exists to wrap. It is an
// OPTIONAL dependency: in local dev without a cluster the Worker falls back to
// its in-memory mock and this bridge is not run. When you DO run the bridge you
// must have installed it and pointed it at a real cluster.
let createClient, AccountFlags, TransferFlags;
try {
  ({ createClient, AccountFlags, TransferFlags } = await import('tigerbeetle-node'));
} catch {
  console.error(
    '[ledger-bridge] tigerbeetle-node not installed. Run `npm i tigerbeetle-node` and start a cluster. Exiting.',
  );
  process.exit(1);
}

const ADDRESS = process.env.TIGERBEETLE_ADDRESS ?? '127.0.0.1:3000';
const PORT = Number(process.env.BRIDGE_PORT ?? 8788);
const TOKEN = process.env.BRIDGE_TOKEN ?? 'dev-bridge-token';

// The single TigerBeetle client for the process lifetime.
const client = createClient({ cluster_id: 0n, replica_addresses: [ADDRESS] });

// ── wire helpers ─────────────────────────────────────────────────────────────
const parseId = (s) => BigInt(s);
const idStr = (id) => id.toString(10);

function deserializeAccount(a) {
  return {
    id: parseId(a.id),
    ledger: a.ledger,
    code: a.code,
    flags: a.flags | AccountFlags.history,
    userData128: a.userData128 ? parseId(a.userData128) : undefined,
    userData64: a.userData64 ?? undefined,
  };
}

function deserializeTransfer(t) {
  return {
    id: parseId(t.id),
    debit_account_id: parseId(t.debit_account_id),
    credit_account_id: parseId(t.credit_account_id),
    amount: parseId(t.amount),
    pending_id: parseId(t.pending_id ?? '0'),
    flags: t.flags,
    ledger: t.ledger,
    code: t.code,
  };
}

function errorName(err) {
  // tigerbeetle-node returns CreateXError enums (numbers). Map to the symbolic
  // name the Worker expects ('exists', 'linked_components_must_be_set', ...).
  return typeof err === 'number' ? CREATE_ERROR_NAMES[err] ?? String(err) : String(err);
}

// Numeric enum values from tigerbeetle-node's CreateTransferError / CreateAccountError.
const CREATE_ERROR_NAMES = {
  1: 'exists',
  2: 'id_must_be_zero_or_not',
  3: 'linked_transfer_must_be_zero_or_not',
  4: 'debit_account_must_be_zero_or_not',
  5: 'credit_account_must_be_zero_or_not',
  6: 'debit_account_id_must_be_zero_or_not',
  7: 'credit_account_id_must_be_zero_or_not',
  8: 'amount_must_be_zero_or_not',
  9: 'flags_are_inconsistent',
  10: 'not_found',
  11: 'debit_account_not_found',
  12: 'credit_account_not_found',
  13: 'accounts_different_ledgers',
  14: 'transfer_exists',
  15: 'pending_transfer_exists',
  16: 'pending_transfer_not_found',
  17: 'pending_transfer_not_pending',
  18: 'pending_transfer_expired',
  19: 'overflows_debits',
  20: 'overflows_credits',
  21: 'overflows_pending_debits',
  22: 'overflows_pending_credits',
  23: 'overflows_timeout',
  24: 'exceeds_credits',
  25: 'exceeds_debits',
  26: 'invalid_update',
};

async function createAccounts(body) {
  const accounts = (body.accounts ?? []).map(deserializeAccount);
  if (accounts.length === 0) return [];
  const errors = await client.createAccounts(accounts);
  return accounts.map((a, index) => ({
    id: idStr(a.id),
    error: index in errors ? errorName(errors[index]) : null,
    index,
  }));
}

async function createTransfers(body) {
  const transfers = (body.transfers ?? []).map(deserializeTransfer);
  if (transfers.length === 0) return [];
  const errors = await client.createTransfers(transfers);
  return transfers.map((t, index) => ({
    id: idStr(t.id),
    error: index in errors ? errorName(errors[index]) : null,
    index,
  }));
}

async function lookupAccounts(body) {
  const ids = (body.ids ?? []).map(parseId);
  const rows = await client.lookupAccounts(ids);
  return ids.map((id, i) => {
    const r = rows[i];
    if (!r) return null;
    return {
      id: idStr(id),
      debits_pending: r.debits_pending.toString(),
      debits_posted: r.debits_posted.toString(),
      credits_pending: r.credits_pending.toString(),
      credits_posted: r.credits_posted.toString(),
    };
  });
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const auth = req.headers['authorization'] ?? '';
  if (auth !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
    const path = req.url ?? '';
    try {
      let out;
      if (path === '/v1/accounts/create') out = await createAccounts(body);
      else if (path === '/v1/transfers/create') out = await createTransfers(body);
      else if (path === '/v1/accounts/lookup') out = await lookupAccounts(body);
      else if (path === '/v1/health') out = { ok: true };
      else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[ledger-bridge] listening on :${PORT} → TigerBeetle ${ADDRESS}`);
});

// Graceful shutdown.
process.on('SIGTERM', () => {
  client.destroy();
  server.close(() => process.exit(0));
});

// Type shim for running under tsx/ts-node without a full tigerbeetle type dep.
export {};