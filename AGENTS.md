# Miirra Pay — Agent Briefing

Standalone payments worker for Miirra (LYD). Own repo, own worker (port **8791**),
own Neon schema (`miirra_pay`) inside the shared `miirra_auth_db`. Shares the
Better Auth sessions for identity; owns the LYPay rail + TigerBeetle ledger.

> **Scope reversal (2026-11-24, owner decree):** the original brief forbade
> wallet-to-wallet transfers (a CBL-style constraint). The owner has since
> explicitly directed that wallet-to-wallet LYD transfers BE implemented
> (`POST /api/wallets/transfer`). That flow moves internal Miirra balances
> between user `tb_account_id` accounts in TigerBeetle — it does **not** move
> money over the bank rail. This document records the reversal so it is not
> silent drift.

## Run it

```bash
npm install
node scripts/migrate.mjs           # apply schema (ws Pool driver; idempotent)
npx wrangler dev --port 8791       # ALWAYS 8791 (8790 = miirra-api, 8787 = partner agent)
node tests/mock-lypay.mjs          # standalone mock LYPay on :8799 (separate shell)
node tests/e2e.mjs                 # full E2E suite → 31/31 green
npx tsc --noEmit                   # must be clean
```

Env (`.dev.vars`): `DATABASE_URL` (Neon pooled), `AUTH_DEV_MODE=1`,
`LYPAY_BASE_URL=http://127.0.0.1:8799` + `LYPAY_TOKEN=mock-token`,
`LEDGER_MODE=mock`, `LYPAY_WEBHOOK_SECRET=mock-webhook-secret`,
`PLATFORM_INSTITUTION_CODE=000`, `PLATFORM_RECEIVING_IBAN=...`.
Production adds: `DIDIT_API_KEY`, `DIDIT_WEBHOOK_SECRET`, `DIDIT_WORKFLOW_ID`,
`LEDGER_BRIDGE_URL`, `LEDGER_BRIDGE_TOKEN`, `LEDGER_MODE=http`, real
`LYPAY_*` creds. **Never** set `AUTH_DEV_MODE` in prod.

## Layout

- `src/index.ts` — app, CORS, `{error:{code,message}}` shaping, route mounts.
- `src/auth.ts` — Better Auth session verify (raw SQL on `public.session`),
  `x-dev-user` dev impersonation, `requireAuth`.
- `src/env.ts` — typed bindings (all secrets server-side only).
- `src/money.ts` — **single source of truth** for LYD minor-unit scaling,
  `FACE_VERIFY_THRESHOLD_MINOR` (1,000 LYD = 100000), rail caps, conversions.
- `src/runtime.ts` — build `LedgerService` + `RailLimits` from env.
- `src/ledger.ts` — TigerBeetle HTTP bridge client (+ in-memory mock fallback).
- `src/ledger-service.ts` — `createPendingSplitChain`, `postPendingTransfers`,
  `voidPendingTransfers`, `createPostedRefund`, `createWalletTransfer`,
  `createWithdrawalHold`, `postTopUpCredit`. Linked-chain + timeout + safe
  retry-outcome classification (`allSettled`, `realFailures`).
- `src/ledger-codes.ts` — u128 id derivation, system accounts, flags.
- `src/lypay.ts` — CBL LYPay v1 client (verified against the official Postman
  spec). Two-step initiate→confirm, refund, status; mock + HTTP modes.
- `src/didit.ts` — Didit session create + X-Signature-V2 webhook verify.
- `src/notifications.ts` — best-effort notify; **never rolls back a payment**.
- `src/webhook-hmac.ts` — LYPay HMAC verify (fail-closed).
- `src/db/schema.ts` — 12 tables in `miirra_pay`.
- `src/routes/` — `topups`, `payments`, `wallets`, `withdrawals`,
  `verifications`, `didit-webhooks`, `webhooks` (LYPay), `health`.
- `ledger-service.mjs` — standalone TigerBeetle **bridge** (native
  `tigerbeetle-node` + authenticated HTTP surface). Runs where native addons
  can (a VM/container next to the cluster), NOT in the Worker.
- `tests/mock-lypay.mjs` — standalone mock LYPay server (real HTTP client path).
- `tests/e2e.mjs` — 31-check E2E suite.
- `tests/miirra-pay.postman_collection.json` — Postman requests + HMAC pre-request.

## Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | NeonDB + TigerBeetle bridge readiness (no secrets) |
| GET | `/v1/me` | whoami (proves auth) |
| POST | `/api/topups/initiate` | top-up intent → deposit reference + receiving details |
| GET | `/api/topups`, `/api/topups/:id` | list / read top-ups |
| POST | `/api/payments/initiate` | P2P/P2M/M2M initiate (two-phase pending) |
| POST | `/api/payments/confirm` | confirm → post/void/await-webhook |
| POST | `/api/payments/refund` | M2P refund (≤ refundable) |
| POST | `/api/wallets/transfer/resolve` | resolve IBAN/QR/phone/NAD → party |
| POST | `/api/wallets/transfer` | wallet-to-wallet (limits + face gate + notify) |
| POST | `/api/withdrawals/initiate` | wallet → LYPay bank (hold + rail initiate) |
| POST | `/api/withdrawals/confirm` | confirm → post/void |
| GET | `/api/withdrawals/:id/status` | active status enquiry |
| POST | `/api/verifications/didit/session` | create Didit KYC/KYB session |
| GET | `/api/verifications`, `/:id` | list / read verifications |
| POST | `/webhooks/lypay` | LYPay inbound (HMAC, dedupe) |
| POST | `/webhooks/didit` | Didit inbound (X-Signature-V2, dedupe) |

## Non-negotiable gotchas

1. **Neon HTTP driver loses DDL + `unsafe()` writes.** Migrations run ONLY via
   `scripts/migrate.mjs` (ws Pool, idempotent, rewrites CREATE/ADD COLUMN to
   `IF NOT EXISTS`). Runtime writes use drizzle **tagged templates only**.
2. **`drizzle-kit push` hangs.** Use `drizzle-kit generate` then `migrate.mjs`.
3. **BIGINT comes back as a STRING** from raw `db.execute`. Coerce with
   `Number()` / `BigInt()` before comparing — a `"500000" === 500000` is false
   and was a real top-up bug.
4. **`payment_transactions.principal_minor` is NOT NULL** with no default —
   every INSERT (refund, topup credit) must include it.
5. **The in-process mock ledger is per-request** (fresh `MockLedgerClient` each
   call), so it CANNOT hold a balance across requests. For cross-request
   balance tests, run the E2E (which uses the standalone mock LYPay) and rely on
   the withdrawal's `isMock` balance-check skip. Real balances need the bridge.
6. **PowerShell 5.1 mangles inline node regex** — write script files.
7. **Don't delete `.wrangler` while wrangler runs** — it crash-loops on a
   half-written bundle. Stop workerd first, then clear.
8. **`notFound`/`forbidden` take only a message** (no code arg); `badRequest`/
   `conflict` take `(message, code)`.

## Two-phase ledger invariant

Every money movement is PENDING first (reserved), then POSTed (completed) or
VOIDed (released). `linked` chains commit atomically (final leg omits `linked`).
Retries are safe: a re-posted pending returns `exists` /
`pending_transfer_not_pending` / `pending_transfer_expired`, all of which
`allSettled()` treats as success. Pending transfers carry a configurable timeout
(`LEDGER_PENDING_TIMEOUT_SECONDS`) so an abandoned reservation auto-expires.

## CBL LYPay v1 facts (verified vs Postman 30951400/2sA3JGfjN7)

- Base `/api/v1/`. Auth: `POST /api/v1/auth/token` (email/password/expiry).
- Amounts = minor-unit **decimal strings** ("2000760" = 2000.760 LYD).
- Status codes: `01` acknowledged, `02` processing, `03` completed, `04` declined.
- Errors: `{ "error": { "code", "message", "errors" } }` (nested under `error`).
- Rate limit 300/min, `X-RateLimit-*` headers, 429 on breach.
- Webhooks: `transaction_status_update`, `transaction_credit_notice`.
- internalMerchantReference (P2M): `[INST 3][TIMESTAMP 10][REF 8 alnum]`.
- Refund body keys are snake_case (`payment_reference`, `transaction_timestamp`);
  confirm body keys are camelCase (`paymentReference`, `transactionTimestamp`).