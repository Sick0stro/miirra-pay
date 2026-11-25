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
    /** Pending-transfer timeout in seconds (auto-expire abandoned reservations). */
    LEDGER_PENDING_TIMEOUT_SECONDS?: string;

    // ── Rail limits (minor units; override the defaults in money.ts) ───────
    /** Max single transfer, minor units. */
    RAIL_PER_TRANSFER_MINOR?: string;
    /** Max cumulative outflow per user per rolling 24h, minor units. */
    RAIL_DAILY_MINOR?: string;

    /** This institution's receiving IBAN / NAD alias shown for top-ups. */
    PLATFORM_RECEIVING_IBAN?: string;
    /** This institution's LYPay code (3 digits) for internal merchant references. */
    PLATFORM_INSTITUTION_CODE?: string;

    /** 0/1 switch: when '1', payments run fully against the mock LYPay. */
    PAYMENTS_MOCK?: string;

    // ── Didit (KYC / face verification) — server-side only ─────────────────
    /** Didit API key (X-Api-Key). Server-side only — never sent to a client. */
    DIDIT_API_KEY?: string;
    /** Didit API base (default https://apx.didit.me). */
    DIDIT_BASE_URL?: string;
    /** HMAC secret for verifying inbound Didit webhooks. */
    DIDIT_WEBHOOK_SECRET?: string;
    /** Default Didit workflow id (KYC/KYB) used when a request omits workflowId. */
    DIDIT_WORKFLOW_ID?: string;

    // ── CBL regulatory perimeter (server-side) ─────────────────────────────
    /** '1' when a CBL license is active (licensed live operation). */
    CBL_LICENSE_ACTIVE?: string;
    /** '1' to run in the CBL sandbox (pilot cohort only). */
    CBL_SANDBOX_MODE?: string;
    /** Comma-separated user ids allowed to transact in sandbox mode. */
    CBL_SANDBOX_USER_IDS?: string;
    /** The CBL-approved Libya region (e.g. 'ly-tripoli'); refuses off-shore. */
    CBL_APPROVED_REGION?: string;

    // ── Static assets (the React SPA in web/dist) ──────────────────────────
    /** Cloudflare ASSETS binding — serves the built Miirra Pay SPA. */
    ASSETS: Fetcher;

    // ── Clerk (phone OTP auth) — server-side token verification ────────────
    /** Clerk JWKS URL, e.g. https://<domain>/.well-known/jwks.json */
    CLERK_JWKS_URL?: string;
    /** Expected issuer (Clerk instance domain / FAPI), e.g. https://<domain> */
    CLERK_ISSUER?: string;
    /** Expected audience, if the session token is audience-scoped. */
    CLERK_AUDIENCE?: string;
  };
  Variables: {
    auth: AuthUser;
    /** The resolved LYPay bearer token (cached per request). */
    lypayToken?: string;
  };
};