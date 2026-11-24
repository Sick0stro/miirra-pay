/**
 * CBL LYPay API v1 client.
 *
 * Verified against the official Postman collection
 * (documenter.getpostman.com/view/30951400/2sA3JGfjN7) on 2026-11-24. The
 * shapes below are transcribed from that collection's example requests and
 * responses — NOT invented. Where the GitBook pages were thin on field detail
 * (they defer to Postman), Postman is the source of truth and that is what this
 * client follows.
 *
 * KEY FACTS baked in here (so callers do not have to remember them):
 *  - Base path is `/api/v1/...`.
 *  - Auth: Bearer token from POST /api/v1/auth/token (email/password/expiry),
 *    or a static token when one is pre-issued.
 *  - Amounts are MINOR-UNIT DECIMAL STRINGS ("2000760" = 2000.760 LYD).
 *  - Two-step: funds-transfers (initiate) → .../{uuid}/confirm. Acknowledge
 *    (status 01) is NOT completion.
 *  - Status codes: 01 acknowledged, 02 processing, 03 completed, 04 declined.
 *  - Errors come back as { "error": { "code","message","errors" } } — nested
 *    under `error`, not a flat `{errors:{...}}` (the brief's example was
 *    simplified; the live spec nests it, so we parse the nested form).
 *  - Rate limit: 300 req/min, X-RateLimit-* headers, 429 on breach.
 *  - Webhook events: `transaction_status_update` and `transaction_credit_notice`.
 *  - Refund body keys are snake_case (payment_reference, transaction_timestamp);
 *    confirm body keys are camelCase (paymentReference, transactionTimestamp).
 */

import { UpstreamError, providerDeclined, upstream } from './errors';

export type LypayConfig = {
  baseUrl: string;
  email?: string;
  password?: string;
  /** Pre-issued static token; skips the auth/token call when set. */
  token?: string;
  /** 'mock' routes through the in-memory mock instead of real HTTP. */
  mode?: 'http' | 'mock';
  /** Per-request timeout. */
  timeoutMs?: number;
};

// ── Wire types (verified against Postman) ────────────────────────────────────

export type LypayStatus = {
  name: 'acknowledged' | 'processing' | 'completed' | 'declined';
  code: '01' | '02' | '03' | '04';
  message?: string;
};

export type LypayAccount = {
  schemeName: string;
  identification: string;
  name: string;
};

export type LypayAmount = { currency: string; amount: string; fees?: string };

export type LypayNumoNotice = {
  debit?: { authNum?: string; refNum?: string; respcode?: string; respcodeDesc?: string };
  credit?: { authNum?: string; refNum?: string; respcode?: string; respcodeDesc?: string };
  reverse?: unknown;
};

export type LypayTransaction = {
  uuid: string;
  paymentReference: string;
  status: LypayStatus;
  transactionDateTime: string;
  transactionTimestamp: number;
  valueDateTime: string;
  transactionType: 'P2P' | 'P2M' | 'M2M' | 'M2P';
  debtorAmount: LypayAmount;
  creditorAmount: LypayAmount;
  debtorAccount: LypayAccount;
  creditorAccount: LypayAccount;
  creditorInstitution: { name: string; code: string };
  additionalData?: Record<string, string>;
  numoNotice?: LypayNumoNotice;
  internalMerchantReference?: string;
  description?: string;
  refund?: { isRefunded: boolean; transactions: unknown[] };
};

export type LypayInitiateBody = {
  transactionType: 'P2P' | 'P2M' | 'M2M';
  initiation: {
    amount: { amount: string; currency: string };
    debtorAccount: LypayAccount;
    creditorAccount: LypayAccount;
    creditorInstitution: { name: string; code: string };
    additionalData?: Record<string, string>;
    description: string;
    internalMerchantReference?: string;
  };
};

export type LypayConfirmBody = {
  paymentReference: string;
  transactionTimestamp: string | number;
};

export type LypayRefundBody = {
  payment_reference: string;
  transaction_timestamp: string | number;
  amount: string;
  description: string;
};

// ── Errors ───────────────────────────────────────────────────────────────────

/** The nested LYPay error envelope: { error: { code, message, errors } }. */
export type LypayErrorEnvelope = {
  error?: { code?: string; message?: string; errors?: unknown };
  errors?: { code?: string; message?: string };
};

function parseErrorEnvelope(body: unknown): { code?: string; message?: string } {
  const b = (body ?? {}) as LypayErrorEnvelope;
  const nested = b.error ?? b.errors ?? {};
  return { code: nested.code, message: nested.message };
}

// ── Mock ─────────────────────────────────────────────────────────────────────

type MockState = {
  txns: Map<string, LypayTransaction>;
  /** How the next confirm should resolve, keyed by uuid. */
  confirmPlan: Map<string, 'complete' | 'decline' | 'processing'>;
};

function newMock(): MockState {
  return { txns: new Map(), confirmPlan: new Map() };
}

// ── Client ───────────────────────────────────────────────────────────────────

export class LypayClient {
  private mock: MockState | null;
  private staticToken: string | null;

  constructor(private cfg: LypayConfig) {
    this.mock = cfg.mode === 'mock' ? newMock() : null;
    this.staticToken = cfg.token ?? null;
  }

  private base(): string {
    return this.cfg.baseUrl.replace(/\/$/, '');
  }

  /** Bearer token, minting one from email/password if needed (cached in cfg.token). */
  async getToken(force = false): Promise<string> {
    if (this.staticToken && !force) return this.staticToken;
    if (this.mock) return 'mock-token';

    const body = {
      email: this.cfg.email,
      password: this.cfg.password,
      token_name: 'miirra-pay',
      token_expiration_date: defaultExpiry(),
    };
    const res = await this.raw('/api/v1/auth/token', body);
    const data = (res.body as { data?: { token?: { value?: string } } })?.data;
    const value = data?.token?.value;
    if (!value) {
      const e = parseErrorEnvelope(res.body);
      throw new UpstreamError(502, 'lypay_token_failed', e.message ?? 'no token in LYPay response', res.status, res.body);
    }
    this.staticToken = value;
    return value;
  }

  async initiate(body: LypayInitiateBody): Promise<LypayTransaction> {
    if (this.mock) return this.mockInitiate(body);
    const token = await this.getToken();
    const res = await this.raw('/api/v1/payments/funds-transfers', body, token);
    return this.expectTransaction(res, 201);
  }

  async confirm(uuid: string, body: LypayConfirmBody): Promise<LypayTransaction> {
    if (this.mock) return this.mockConfirm(uuid, body);
    const token = await this.getToken();
    const res = await this.raw(`/api/v1/payments/funds-transfers/${uuid}/confirm`, body, token);
    return this.expectTransaction(res, 201);
  }

  async refund(uuid: string, body: LypayRefundBody): Promise<LypayTransaction> {
    if (this.mock) return this.mockRefund(uuid, body);
    const token = await this.getToken();
    const res = await this.raw(`/api/v1/payments/funds-transfers/${uuid}/refund`, body, token);
    return this.expectTransaction(res, 200);
  }

  async status(
    uuid: string,
    params: { paymentReference: string; transactionTimestamp: string | number },
  ): Promise<LypayTransaction> {
    if (this.mock) {
      const t = this.mock?.txns.get(uuid);
      if (!t) throw notFoundMock();
      return t;
    }
    const token = await this.getToken();
    const qs = new URLSearchParams({
      paymentReference: params.paymentReference,
      transactionTimestamp: String(params.transactionTimestamp),
    });
    const res = await this.raw(`/api/v1/payments/funds-transfers/${uuid}?${qs}`, undefined, token, 'GET');
    return this.expectTransaction(res, 200);
  }

  // ── internal ─────────────────────────────────────────────────────────────

  private async raw(
    path: string,
    body?: unknown,
    token?: string,
    method?: string,
  ): Promise<{ status: number; body: unknown; headers: Headers }> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 8000);
    try {
      const res = await fetch(`${this.base()}${path}`, {
        method: method ?? (body !== undefined ? 'POST' : 'GET'),
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { status: res.status, body: parsed, headers: res.headers };
    } catch (err) {
      throw upstream(`LYPay request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(t);
    }
  }

  private expectTransaction(res: { status: number; body: unknown; headers: Headers }, ok: number): LypayTransaction {
    if (res.status === 429) {
      throw new UpstreamError(502, 'lypay_rate_limited', 'LYPay rate limit hit', 429, res.body);
    }
    if (res.status < 200 || res.status >= 300) {
      const e = parseErrorEnvelope(res.body);
      // A business decline (e.g. a 4xx with an error code) is a providerDeclined;
      // a transport/5xx is an upstream error.
      if (res.status >= 400 && res.status < 500) {
        throw providerDeclined(e.message ?? 'LYPay declined the request', `lypay_${e.code ?? 'declined'}`);
      }
      throw upstream(e.message ?? `LYPay returned ${res.status}`, res.status, res.body);
    }
    void ok; // accepted-range marker kept for readability at call sites
    const data = (res.body as { data?: LypayTransaction })?.data;
    if (!data?.uuid) {
      throw upstream('LYPay response missing data.uuid', res.status, res.body);
    }
    return data;
  }

  // ── mock implementations (drive the E2E suite deterministically) ───────────

  private mockInitiate(body: LypayInitiateBody): LypayTransaction {
    const amount = body.initiation.amount.amount;
    const uuid = crypto.randomUUID();
    const pr = crypto.randomUUID();
    const now = Date.now();
    const txn: LypayTransaction = {
      uuid,
      paymentReference: pr,
      status: { name: 'acknowledged', code: '01', message: 'MOCK ACK' },
      transactionDateTime: new Date(now).toISOString(),
      transactionTimestamp: Math.floor(now / 1000),
      valueDateTime: new Date(now).toISOString(),
      transactionType: body.transactionType,
      debtorAmount: { currency: amount ? body.initiation.amount.currency : 'lyd', amount, fees: '0' },
      creditorAmount: { currency: body.initiation.amount.currency, amount, fees: '0' },
      debtorAccount: body.initiation.debtorAccount,
      creditorAccount: body.initiation.creditorAccount,
      creditorInstitution: body.initiation.creditorInstitution,
      additionalData: body.initiation.additionalData,
      numoNotice: {},
      internalMerchantReference: body.initiation.internalMerchantReference,
      description: body.initiation.description,
      refund: { isRefunded: false, transactions: [] },
    };
    this.mock!.txns.set(uuid, txn);
    // Default: confirm completes immediately (deterministic for P2M/M2M tests).
    this.mock!.confirmPlan.set(uuid, 'complete');
    return txn;
  }

  private mockConfirm(uuid: string, _body: LypayConfirmBody): LypayTransaction {
    const txn = this.mock!.txns.get(uuid);
    if (!txn) throw notFoundMock();
    const plan = this.mock!.confirmPlan.get(uuid) ?? 'complete';
    if (plan === 'decline') {
      txn.status = { name: 'declined', code: '04', message: 'MOCK DECLINE' };
    } else if (plan === 'processing') {
      txn.status = { name: 'processing', code: '02', message: 'MOCK PROCESSING' };
    } else {
      txn.status = { name: 'completed', code: '03', message: 'MOCK COMPLETED' };
    }
    return txn;
  }

  private mockRefund(uuid: string, body: LypayRefundBody): LypayTransaction {
    const orig = this.mock!.txns.get(uuid);
    if (!orig) throw notFoundMock();
    // A refund creates its own M2P transaction record in LYPay.
    const amount = body.amount;
    const now = Date.now();
    const refund: LypayTransaction = {
      uuid: crypto.randomUUID(),
      paymentReference: crypto.randomUUID(),
      status: { name: 'completed', code: '03', message: 'MOCK REFUND COMPLETED' },
      transactionDateTime: new Date(now).toISOString(),
      transactionTimestamp: Math.floor(now / 1000),
      valueDateTime: new Date(now).toISOString(),
      transactionType: 'M2P',
      debtorAmount: { currency: 'lyd', amount, fees: '0' },
      creditorAmount: { currency: 'lyd', amount, fees: '0' },
      debtorAccount: orig.creditorAccount,
      creditorAccount: orig.debtorAccount,
      creditorInstitution: orig.creditorInstitution,
      description: body.description,
      refund: { isRefunded: true, transactions: [] },
    };
    this.mock!.txns.set(refund.uuid, refund);
    return refund;
  }

  /** Test hook: set how a mock initiated txn will resolve on confirm. */
  mockSetConfirmPlan(uuid: string, plan: 'complete' | 'decline' | 'processing') {
    this.mock?.confirmPlan.set(uuid, plan);
  }
}

function defaultExpiry(): string {
  const d = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

const notFoundMock = () => new UpstreamError(502, 'lypay_mock_not_found', 'mock LYPay: unknown transaction');

/**
 * Build a LYPay client from worker env.
 *
 * Mock mode is used when PAYMENTS_MOCK=1 or when no base URL / credentials are
 * configured — so local dev and the E2E suite run with zero external deps, the
 * same philosophy as DEMO_MODE in the rider/super apps.
 */
export function lypayFromEnv(env: {
  LYPAY_BASE_URL?: string;
  LYPAY_EMAIL?: string;
  LYPAY_PASSWORD?: string;
  LYPAY_TOKEN?: string;
  PAYMENTS_MOCK?: string;
}): LypayClient {
  const mock = env.PAYMENTS_MOCK === '1' || !env.LYPAY_BASE_URL || (!env.LYPAY_TOKEN && !env.LYPAY_EMAIL);
  return new LypayClient({
    baseUrl: env.LYPAY_BASE_URL ?? 'http://127.0.0.1:8799',
    email: env.LYPAY_EMAIL,
    password: env.LYPAY_PASSWORD,
    token: env.LYPAY_TOKEN,
    mode: mock ? 'mock' : 'http',
  });
}

export type { LypayClient as ILypayClient };