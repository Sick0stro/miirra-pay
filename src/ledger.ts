/**
 * TigerBeetle client over the internal authenticated HTTP bridge.
 *
 * WHY A BRIDGE, NOT tigerbeetle-node DIRECTLY
 * --------------------------------------------
 * `tigerbeetle-node` is a native N-API addon: it is a compiled `.node` binary
 * linked against a running TigerBeetle cluster, and it cannot execute inside a
 * Cloudflare Worker (no native modules, no raw sockets, v8 isolates). Miirra
 * Pay runs on Workers, so the Worker never links TigerBeetle. Instead a small
 * long-running Node service — `ledger-service.ts`, deployed where native
 * addons CAN run (a VM, Fly.io, a container) — owns the real `tigerbeetle-node`
 * Client and exposes THIS HTTP surface. The Worker holds only a bearer token for
 * that bridge, server-side, and never sees the cluster address.
 *
 * The bridge is the ONE place secrets and native code live. If this contract
 * ever changes, it changes in lockstep with `ledger-service.ts`.
 *
 * AUTH: every call carries `Authorization: Bearer <LEDGER_BRIDGE_TOKEN>`.
 * The token is a worker secret — it never reaches a client, a merchant UI, or
 * an agent tool schema.
 *
 * IDEMPOTENCY: create_accounts / create_transfers are idempotent by id in
 * TigerBeetle (a replayed id returns `exists`/`exists` and is treated as
 * success). The bridge returns per-item results so the caller can tell a real
 * failure from an "already done".
 */

import { idStr } from './ledger-codes';

/** A single per-item result from a TigerBeetle batch operation. */
export type TbItemResult = {
  /** u128 decimal string of the account/transfer id. */
  id: string;
  /** TigerBeetle CreateTransferError / CreateAccountError code, null on success. */
  error: string | null;
  /** 0-based index into the submitted batch. */
  index: number;
};

export type TbAccount = {
  id: bigint;
  /** u128 decimal string of the account this one is the authoritative mirror of (the system/user id). */
  ledger: number;
  code: number;
  flags: number;
  /** u128 decimal string id of the account that debits/credits must balance against. */
  userData128?: bigint | null;
  /** Opaque 64-bit user data (fits a JS number for our ids). */
  userData64?: number | null;
  history?: number;
};

export type TbTransfer = {
  id: bigint;
  debit_account_id: bigint;
  credit_account_id: bigint;
  amount: bigint;
  /** u128 pending transfer id for post/void legs; 0 otherwise. */
  pending_id?: bigint;
  /** u128 balancing account id for fee legs (0 if none). */
  balancing_account_id?: bigint;
  /** TigerBeetle timeout as nanoseconds since epoch (0 = none). */
  timeout_date?: bigint;
  flags: number;
  ledger: number;
  code: number;
  userData128?: bigint | null;
  userData64?: number | null;
};

export type BridgeConfig = {
  /** Base URL of the internal bridge, e.g. http://ledger.bridge:8088 */
  baseUrl: string;
  /** Bearer token — a worker secret, server-side only. */
  token: string;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  /** Set to 'mock' to use the in-memory fallback instead of HTTP. */
  mode?: 'http' | 'mock';
};

/** The surface the rest of the app codes against. Mockable for tests. */
export interface LedgerClient {
  createAccounts(accounts: TbAccount[]): Promise<TbItemResult[]>;
  createTransfers(transfers: TbTransfer[]): Promise<TbItemResult[]>;
  lookupAccounts(ids: bigint[]): Promise<
    Array<{ id: string; debits_pending: bigint; debits_posted: bigint; credits_pending: bigint; credits_posted: bigint } | null>
  >;
  health(): Promise<boolean>;
}

export class LedgerBridgeError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'LedgerBridgeError';
  }
}

/** HTTP transport to the real bridge service. */
class HttpLedgerClient implements LedgerClient {
  constructor(private cfg: Required<Pick<BridgeConfig, 'baseUrl' | 'token'>> & BridgeConfig) {}

  private async call<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}${path}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 5000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.token}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      // A bridge outage must be loud and distinct from a ledger decline — a
      // caller retrying a decline forever is as wrong as one dropping a real
      // outage. Surface it as a 502-class error.
      throw new LedgerBridgeError(502, `ledger bridge unreachable: ${(err as Error).message}`);
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) {
      let detail: unknown = null;
      try {
        detail = await res.json();
      } catch {
        detail = await res.text().catch(() => null);
      }
      throw new LedgerBridgeError(res.status, `ledger bridge ${res.status}`, detail);
    }
    return (await res.json()) as T;
  }

  createAccounts(accounts: TbAccount[]) {
    return this.call<TbItemResult[]>('/v1/accounts/create', {
      accounts: accounts.map(serializeAccount),
    });
  }
  createTransfers(transfers: TbTransfer[]) {
    return this.call<TbItemResult[]>('/v1/transfers/create', {
      transfers: transfers.map(serializeTransfer),
    });
  }
  async lookupAccounts(ids: bigint[]) {
    const rows = await this.call<
      Array<{
        id: string;
        debits_pending: string;
        debits_posted: string;
        credits_pending: string;
        credits_posted: string;
      } | null>
    >('/v1/accounts/lookup', { ids: ids.map(idStr) });
    return rows.map((r) =>
      r
        ? {
            id: r.id,
            debits_pending: BigInt(r.debits_pending),
            debits_posted: BigInt(r.debits_posted),
            credits_pending: BigInt(r.credits_pending),
            credits_posted: BigInt(r.credits_posted),
          }
        : null,
    );
  }
  async health() {
    try {
      await this.call('/v1/health', {});
      return true;
    } catch {
      return false;
    }
  }
}

// ── wire (de)serialization ──────────────────────────────────────────────────
// TigerBeetle ids and amounts are u128. JSON has no integer type safe past 2^53,
// so they cross the bridge as DECIMAL STRINGS and are parsed back to BigInt here.

type WireAccount = {
  id: string;
  ledger: number;
  code: number;
  flags: number;
  userData128: string | null;
  userData64: number | null;
  history: number;
};
type WireTransfer = {
  id: string;
  debit_account_id: string;
  credit_account_id: string;
  amount: string;
  pending_id: string;
  balancing_account_id: string;
  timeout_date: string;
  flags: number;
  ledger: number;
  code: number;
  userData128: string | null;
  userData64: number | null;
};

export const serializeAccount = (a: TbAccount): WireAccount => ({
  id: idStr(a.id),
  ledger: a.ledger,
  code: a.code,
  flags: a.flags,
  userData128: a.userData128 != null ? idStr(a.userData128) : null,
  userData64: a.userData64 ?? null,
  history: a.history ?? 0,
});

export const serializeTransfer = (t: TbTransfer): WireTransfer => ({
  id: idStr(t.id),
  debit_account_id: idStr(t.debit_account_id),
  credit_account_id: idStr(t.credit_account_id),
  amount: idStr(t.amount),
  pending_id: t.pending_id != null ? idStr(t.pending_id) : '0',
  balancing_account_id: t.balancing_account_id != null ? idStr(t.balancing_account_id) : '0',
  timeout_date: t.timeout_date != null ? idStr(t.timeout_date) : '0',
  flags: t.flags,
  ledger: t.ledger,
  code: t.code,
  userData128: t.userData128 != null ? idStr(t.userData128) : null,
  userData64: t.userData64 ?? null,
});

/**
 * In-memory mock — the fallback that lets the whole system (Worker, ledger
 * module, E2E suite) run with NO TigerBeetle cluster and NO bridge, exactly the
 * way the rider/super apps run behind DEMO_MODE. It models the two-phase
 * semantics faithfully enough that the Worker's post/void/refund logic is the
 * REAL logic, not a stub:
 *  - a pending transfer moves funds into `*_pending`
 *  - a post moves the matching pending into `*_posted`
 *  - a void releases the pending back out
 *  - replaying the same transfer id is a no-op (`exists`)
 */
export class MockLedgerClient implements LedgerClient {
  private accounts = new Map<string, { dP: bigint; dQ: bigint; cP: bigint; cQ: bigint }>();
  private transfers = new Map<string, { t: TbTransfer; phase: 'pending' | 'posted' | 'voided' }>();

  private acct(id: string) {
    let a = this.accounts.get(id);
    if (!a) {
      a = { dP: 0n, dQ: 0n, cP: 0n, cQ: 0n };
      this.accounts.set(id, a);
    }
    return a;
  }

  async createAccounts(accounts: TbAccount[]): Promise<TbItemResult[]> {
    const out: TbItemResult[] = [];
    accounts.forEach((a, index) => {
      const id = idStr(a.id);
      const existed = this.accounts.has(id);
      if (!existed) this.accounts.set(id, { dP: 0n, dQ: 0n, cP: 0n, cQ: 0n });
      out.push({ id, error: existed ? 'exists' : null, index });
    });
    return out;
  }

  async createTransfers(transfers: TbTransfer[]): Promise<TbItemResult[]> {
    const out: TbItemResult[] = [];
    transfers.forEach((t, index) => {
      const id = idStr(t.id);
      if (this.transfers.has(id)) {
        out.push({ id, error: 'exists', index });
        return;
      }
      const phase: 'pending' | 'posted' | 'voided' = t.flags & 2 ? 'pending' : 'posted'; // TransferFlags.pending
      this.transfers.set(id, { t, phase });
      this.apply(t, phase);
      out.push({ id, error: null, index });
    });
    return out;
  }

  private apply(t: TbTransfer, phase: 'pending' | 'posted' | 'voided') {
    const debit = this.acct(idStr(t.debit_account_id));
    const credit = this.acct(idStr(t.credit_account_id));
    const amt = t.amount;
    if (phase === 'pending') {
      // Pending: debit side reserves (pending debit), credit side reserves (pending credit).
      debit.dP += amt;
      credit.cP += amt;
    } else if (phase === 'posted') {
      // Posting a pending moves pending → posted on both sides.
      if (t.pending_id && t.pending_id !== 0n) {
        debit.dP -= amt;
        debit.dQ += amt;
        credit.cP -= amt;
        credit.cQ += amt;
      } else {
        // Direct (non-pending) posted transfer.
        debit.dQ += amt;
        credit.cQ += amt;
      }
    } else {
      // Voiding a pending releases the reservations.
      if (t.pending_id && t.pending_id !== 0n) {
        debit.dP -= amt;
        credit.cP -= amt;
      }
    }
  }

  async lookupAccounts(ids: bigint[]) {
    return ids.map((id) => {
      const a = this.accounts.get(idStr(id));
      if (!a) return null;
      return {
        id: idStr(id),
        debits_pending: a.dP,
        debits_posted: a.dQ,
        credits_pending: a.cP,
        credits_posted: a.cQ,
      };
    });
  }

  async health() {
    return true;
  }
}

/**
 * Build the right client from config. `mode: 'mock'` (or an explicit mock flag)
 * returns the in-memory fallback; otherwise the real HTTP bridge client.
 */
export function createLedgerClient(cfg: BridgeConfig): LedgerClient {
  if (cfg.mode === 'mock') return new MockLedgerClient();
  return new HttpLedgerClient({
    baseUrl: cfg.baseUrl,
    token: cfg.token,
    timeoutMs: cfg.timeoutMs,
    mode: cfg.mode,
  });
}