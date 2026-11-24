import type { AuthUser } from './auth';

/**
 * Worker bindings + typed context variables.
 *
 * Every secret here is SERVER-SIDE ONLY — a Worker binding / secret is never
 * visible to a browser client, a merchant cashier UI, or an agent tool schema.
 * The client app only ever holds the platform session token.
 */
export type AppEnv = {
  Bindings: {
    /** Pooled Neon Postgres URL (miirra_auth_db). Holds the miirra_pay schema. */
    DATABASE_URL: string;

    /** '1' enables the x-dev-user impersonation header (dev only, never prod). */
    AUTH_DEV_MODE?: string;

    // ── LYPay (CBL) — server-side only, never exposed ──────────────────────
    /** LYPay API base, e.g. https://lypay.cbl.ly — override for the mock in dev. */
    LYPAY_BASE_URL?: string;
    /** Institutional API credentials for POST /api/v1/auth/token. */
    LYPAY_EMAIL?: string;
    LYPAY_PASSWORD?: string;
    /** Static bearer token when issued out-of-band (skips the token call). */
    LYPAY_TOKEN?: string;
    /** HMAC secret used to verify inbound webhook signatures. */
    LYPAY_WEBHOOK_SECRET?: string;

    // ── TigerBeetle bridge — server-side only ─────────────────────────────
    /** Base URL of the internal authenticated ledger bridge. */
    LEDGER_BRIDGE_URL?: string;
    /** Bearer token for the bridge. */
    LEDGER_BRIDGE_TOKEN?: string;
    /**
     * 'mock' forces the in-memory TigerBeetle fallback (no cluster, no bridge).
     * Default when no bridge URL is set — keeps local dev + E2E working with
     * zero external dependencies, exactly like DEMO_MODE elsewhere.
     */
    LEDGER_MODE?: 'http' | 'mock';

    /** This institution's receiving IBAN / NAD alias shown for top-ups. */
    PLATFORM_RECEIVING_IBAN?: string;
    /** This institution's LYPay code (3 digits) for internal merchant references. */
    PLATFORM_INSTITUTION_CODE?: string;

    /** 0/1 switch: when '1', payments run fully against the mock LYPay. */
    PAYMENTS_MOCK?: string;
  };
  Variables: {
    auth: AuthUser;
    /** The resolved LYPay bearer token (cached per request). */
    lypayToken?: string;
  };
};