# Miirra Pay

**LYD payments for Miirra** — a standalone Cloudflare Worker (TypeScript) with a
React wallet front end, a Neon Postgres ledger of record, a TigerBeetle
double-entry ledger, and the CBL **LYPay v1** rail. Built for
**`pay.miirra.com`**.

> **Status:** active development. Runs locally with a mock LYPay + in-memory
> ledger; production wiring (real LYPay, TigerBeetle bridge, CBL licence) is a
> deliberate, owner-approved step. See [DEPLOYMENT.md](./DEPLOYMENT.md).

---

## What it does

- **Wallet-to-wallet LYD transfers** between Miirra users (internal ledger moves,
  not bank-rail).
- **Top-ups** via bank transfer (LYPay / IBAN) or from another Miirra user.
- **Withdrawals** to a linked bank account (same-account rule + typed IBAN
  match) via LYPay two-step.
- **Two-phase ledger** — every movement is `pending → post`/`void` with
  `linked` chains, idempotent by transfer id, with a hash-chained audit log.
- **CBL compliance layer** — licensed/sandbox perimeter, LYD-only, tier caps
  (SDD/CDD/EDD), 1,000-LYD face-verification gate, AML screening, reconciliation,
  complaints/DSAR.
- **Didit** KYC/KYB sessions + signed webhooks.

## Architecture

```
React SPA (web/)  ──fetch──▶  miirra-pay Worker (src/)  ──▶  Neon (miirra_pay schema)
   (pay.miirra.com)            Hono routes + guards            + TigerBeetle (bridge)
                                   │
                                   └─▶ LYPay v1 (CBL) / Didit
```

- **Worker** (`src/`) — Hono on Cloudflare Workers. Owns the API, the CBL
  perimeter, and the ledger-of-record. Secrets are server-side only.
- **SPA** (`web/`) — Vite + React 19 + TypeScript + Tailwind v4, built to
  `web/dist` and served by the worker via the `ASSETS` binding.
- **Ledger** — TigerBeetle via an authenticated bridge (`ledger-service.mjs`),
  with an in-memory mock fallback for local dev.
- **DB** — Neon Postgres, dedicated `miirra_pay` schema (isolated from
  `miirra_api`).

## Quick start

```bash
npm install
node scripts/migrate.mjs            # apply schema (ws Pool driver; idempotent)
node scripts/seed-test-accounts.mjs # fund the demo cast (dev faucet)
npm run build:web                   # build the React SPA → web/dist
npx wrangler dev --port 8791        # API + SPA at http://127.0.0.1:8791/app
```

Optional, in separate shells:

```bash
node tests/mock-lypay.mjs           # standalone mock LYPay on :8799
node tests/e2e.mjs                  # E2E suite
node tests/ui-smoke.mjs             # wallet API smoke
```

**Sign in** at `http://127.0.0.1:8791/app` with a **Dev user id**:
`test-alice` · `test-bob` · `test-carol` · `test-dina`.

## The wallet (React SPA)

Strictly **3-button** floating glass bottom bar — **Card · Pay · Activity** — with
12 screens: Card home (balance, MiirraCard flip + freeze, Standard/Miirra+/Max
tiers), Top-Up (bank LYPay/IBAN copy+QR+Scan IBAN, or from another user), Camera
IBAN scanner, Manage card, Keypad Pay, Scan QR, Recipient & note, Review
(Slide to Pay), **Biometric/Face modal (>1,000 LYD)**, Confirmation, Activity +
receipt/mesh-sync, and a `pay.miirra.com` checkout approval.

Every payment path runs one state machine: **Swipe → (amount > 1000 ? native
biometric : instant) → confirm**. EN/AR with full RTL.

## API (selected)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | NeonDB + TigerBeetle readiness (no secrets) |
| GET | `/v1/me` | whoami |
| GET | `/api/wallets/balance` | caller's LYD balance (ledger-first) |
| GET | `/api/wallets/activity` | money-movement feed |
| POST | `/api/wallets/transfer` | wallet-to-wallet LYD |
| POST | `/api/topups/initiate` | top-up intent → deposit reference |
| POST | `/api/withdrawals/initiate` | wallet → bank (LYPay) |
| POST | `/webhooks/lypay` | LYPay inbound (HMAC, dedupe) |
| POST | `/webhooks/didit` | Didit inbound (signed, dedupe) |

Full route table + gotchas in [AGENTS.md](./AGENTS.md).

## Testing & compliance

- `npx tsc --noEmit` — worker typecheck (clean)
- `node tests/e2e.mjs` — end-to-end
- `node tests/ui-smoke.mjs` — wallet API smoke
- `node evals/cbl/run_all_evals.mjs` — CBL eval harness (see `evals/cbl/`)

## Deploy

Custom domain **`pay.miirra.com`** is wired in `wrangler.toml`. To go live:

```bash
wrangler deploy
```

Set production secrets first (`DATABASE_URL`, `LYPAY_*`, `LEDGER_MODE=http` +
bridge, `CBL_LICENSE_ACTIVE=1`) and **never** `AUTH_DEV_MODE`. Full checklist in
[DEPLOYMENT.md](./DEPLOYMENT.md).

## Docs

- [AGENTS.md](./AGENTS.md) — agent briefing: layout, routes, gotchas, CBL layer
- [DEPLOYMENT.md](./DEPLOYMENT.md) — production deployment checklist
- `evals/cbl/` — audit report, readiness dossier, AMADAT entity checklist

## License

Private — © Miirra. All rights reserved.