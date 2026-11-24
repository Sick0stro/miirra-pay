# Miirra Pay — Production Deployment Checklist

Work top to bottom. Do not skip the secret-handling or the migration-safety
items; the rest can be parallelised.

## 1. Secrets (server-side only — never in a client bundle or repo)

- [ ] `DATABASE_URL` — Neon **pooled** endpoint (`-pooler`), `miirra_auth_db`.
- [ ] `LYPAY_BASE_URL`, `LYPAY_EMAIL`, `LYPAY_PASSWORD` (or `LYPAY_TOKEN`),
      `LYPAY_WEBHOOK_SECRET` — CBL LYPay institutional creds.
- [ ] `LEDGER_BRIDGE_URL`, `LEDGER_BRIDGE_TOKEN`, `LEDGER_MODE=http`.
- [ ] `LEDGER_PENDING_TIMEOUT_SECONDS` (e.g. 900 = 15 min).
- [ ] `RAIL_PER_TRANSFER_MINOR`, `RAIL_DAILY_MINOR` (minor units).
- [ ] `DIDIT_API_KEY`, `DIDIT_WEBHOOK_SECRET`, `DIDIT_WORKFLOW_ID`.
- [ ] `PLATFORM_RECEIVING_IBAN`, `PLATFORM_INSTITUTION_CODE`.
- [ ] **Confirm `AUTH_DEV_MODE` is NOT set** (and `SUPER_ADMIN_IDS` removed).

Set via `wrangler secret put <NAME>` (encrypted) or the dashboard — never in
`wrangler.toml` in plaintext.

## 2. Database

- [ ] Point `DATABASE_URL` at the intended branch (a `production` branch, not a
      preview branch).
- [ ] **Snapshot the branch** before the first migration (Free plan has 6h
      history, no PITR).
- [ ] `node scripts/migrate.mjs` → expect 12 tables in `miirra_pay`, existing
      `miirra_api` tables untouched (`node scripts/check-isolation.mjs` →
      24 + 12).
- [ ] Enable Neon IP Allow (`allowed_ips`) for the Worker egress / bridge.
- [ ] Add a branch-per-PR workflow for future migrations (`neon diff`).

## 3. TigerBeetle bridge

- [ ] Run `ledger-service.mjs` where native addons execute (VM/container next
      to the cluster). Set `TIGERBEETLE_ADDRESS`, `BRIDGE_TOKEN`, `BRIDGE_PORT`.
- [ ] Firewall the bridge to the Worker's egress only; TLS in front.
- [ ] Smoke: `curl -H "Authorization: Bearer $TOKEN" -d '{}' $BRIDGE/v1/health`
      → `{"ok":true}`.
- [ ] Create TigerBeetle system accounts (1=clearing, 2=revenue, 3=refund, 4=
      withdrawal clearing) on first boot, or let `ensureSystemAccounts()` run.

## 4. LYPay / Didit onboarding

- [ ] Register the webhook URL `https://<host>/webhooks/lypay` with LYPay and
      store the HMAC secret.
- [ ] Register `https://<host>/webhooks/didit` as a Didit destination
      (subscribe `status.updated`), store `secret_shared_key` →
      `DIDIT_WEBHOOK_SECRET`.
- [ ] Cloudflare WAF: allow Didit's delivery IP `18.203.201.92`.
- [ ] Publish a Didit workflow (KYC) → `DIDIT_WORKFLOW_ID`.

## 5. Worker deploy

- [ ] `npx tsc --noEmit` clean.
- [ ] `wrangler deploy` (workers.dev, or a custom domain).
- [ ] `GET /health` → 200 with `checks.neon.ok=true` and `checks.ledger.ok=true`
      (or `mode:"mock"` if intentionally no bridge).
- [ ] Point the client app at the deployed base URL.

## 6. Post-deploy verification

- [ ] Run `tests/e2e.mjs` against the **deployed** URL (set `MIIRRA_PAY_URL`)
      with a sandbox LYPay + sandbox Didit + a test branch. Expect all green.
- [ ] Drive the three Postman cases: confirmed withdrawal, declined withdrawal
      (hold voided), duplicate idempotency replay.
- [ ] Confirm a Didit test webhook updates `vendor_verifications` and never
      downgrades an `approved` row.
- [ ] Watch logs for `unmatched_inbound_credits` (should be empty in a clean
      run) and `notification_attempts` failures (retry worker should drain).

## 7. Ongoing

- [ ] A retry worker drains `notification_attempts` where `status='failed'`.
- [ ] Reconcile `unmatched_inbound_credits` daily; alert on any non-zero.
- [ ] Monitor the bridge `health()` and LYPay 429 rate-limit headers.
- [ ] Keep `LEDGER_MODE=mock` OUT of production (balances won't persist).