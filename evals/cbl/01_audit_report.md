# CBL Compliance Audit — Miirra Pay (Phase 1)

Audit against the Central Bank of Libya (CBL) Electronic Payment Services
Regulation (March 2020) + Circular 9/2026 + the 2026 Personal Data Protection
Regulation, as mapped in the supplied build/eval blueprint. Each finding cites
the exact file/symbol and a tag: `[PASS]`, `[WARN]`, `[FAIL]`, or
`[NEEDS_LEGAL_OR_BANK_INPUT]`.

> Scope note: this audits the **server-side payments worker** (`miirra-pay`).
> The offline WiFi/mesh P2P + NAT hole-punching transport lives in the **mesh**
> repo (`miirra_mesh`), not here. Where an article depends on that transport,
> the finding is `[WARN]` with a cross-repo note; the server-side half is
> assessed.

---

## 1. Regulatory & Jurisdiction Perimeter (Art. 2, 7, 8, 9(5), 10(1))

| # | Finding | Evidence | Tag |
|---|---|---|---|
| 1.1 | No CBL license / sandbox gate. Production onboarding is not locked behind a `CBL_LICENSE_ACTIVE` flag; any authed user can transact. | `src/env.ts` has no license/sandbox binding; `src/routes/*` gate only on `requireAuth` | `[FAIL]` |
| 1.2 | No jurisdiction/region guard on execution. Nothing blocks a non-Libya deployment or non-LY endpoint. | `wrangler.toml` (no region pinning); `src/index.ts` (no host allowlist) | `[FAIL]` |
| 1.3 | Currency is de-facto LYD-only (ledger=1, rail strings). No path accepts a non-LYD amount on domestic instruments. | `src/ledger-codes.ts:18` `LEDGER_LYD=1`; `src/routes/payments.ts:183`, `withdrawals.ts:156` hardcode `currency:'lyd'` | `[PASS]` |
| 1.4 | No approved-endpoint/relay allowlist for STUN/TURN/signaling. | Not present in this repo (mesh scope) | `[WARN]` (mesh) |

## 2. Offline WiFi / Mesh P2P & Hole-Punching (Art. 9(8), 9(11), 15, 21(5))

| # | Finding | Evidence | Tag |
|---|---|---|---|
| 2.1 | No server-side offline-transfer acceptance endpoint (no signed offline packet ingest, no monotonic-counter ledger). | No `/api/offline/*` route; `src/routes/wallets.ts` is online-only | `[WARN]` (mesh-owned; server half absent) |
| 2.2 | Pre-funded-balance check exists for online withdrawal but not a reserved `offline_spendable` balance concept. | `src/routes/withdrawals.ts:118` checks available balance | `[WARN]` |
| 2.3 | No double-spend/conflict resolution on reconnect (server side). | Not present | `[WARN]` (mesh) |
| 2.4 | Transport encryption (AEAD) is mesh-layer; server enforces TLS via Workers. | Workers terminate TLS 1.3; no explicit at-rest note here | `[PASS]` (TLS) / `[WARN]` (at-rest) |

## 3. Ledger, Aggregation Accounts & Settlement (Art. 12–15, LYPay/NAD)

| # | Finding | Evidence | Tag |
|---|---|---|---|
| 3.1 | Strict double-entry with two-phase pending→post/void and atomic linked chains. | `src/ledger-service.ts` (`createPendingSplitChain`, `postPendingTransfers`, `voidPendingTransfers`); `src/ledger-codes.ts` system accounts | `[PASS]` |
| 3.2 | **No explicit account-tier segregation** between operating funds, customer sub-aggregation, and the single main settlement account (`حساب التسوية`). System accounts are `PLATFORM_CLEARING/REVENUE/REFUND_SUSPENSE/WITHDRAWAL_CLEARING` — none named/typed as customer-aggregation or settlement. | `src/ledger-codes.ts:22-30` | `[FAIL]` |
| 3.3 | **No 1:1 backing invariant** (`total_e_money_issued == total_aggregation_balance`) is asserted anywhere; reconciliation is not automated. | No reconciliation routine; `scripts/` has no recon | `[FAIL]` |
| 3.4 | Spendable credit is posted only after settlement finality for top-ups (webhook-matched), and withdrawals hold-then-post on confirm. | `src/routes/topups.ts` `confirmTopup`; `src/routes/withdrawals.ts` post/void | `[PASS]` |

## 4. KYC / AML & Transaction Monitoring (Art. 9(8), 22)

| # | Finding | Evidence | Tag |
|---|---|---|---|
| 4.1 | KYC/KYB gating exists via Didit; high-value step-up (>1000 LYD) enforced on wallet + withdrawal. | `src/routes/wallets.ts`, `withdrawals.ts` `needsFaceVerification`; `src/money.ts` | `[PASS]` |
| 4.2 | No sanctions/AML screening hook, no velocity/structuring rule beyond a simple daily cap, no suspicious-activity flag. | Only `railLimitsFromEnv` daily cap | `[WARN]` |
| 4.3 | Separation of duties / dual control: not enforced in code (no role gate for settlement ops). | `src/auth.ts` (auth only) | `[WARN]` |
| 4.4 | KYC gating blocks unverified **high-value** transfers only; low-value transfers have no identity check at all. | `needsFaceVerification` threshold gate | `[WARN]` |

## 5. Privacy, Security & Auditability (Art. 16–25, 27; 2026 PDPR)

| # | Finding | Evidence | Tag |
|---|---|---|---|
| 5.1 | Secrets server-side only (LYPay, Didit, bridge token never in client). | `src/env.ts`; routes never return bindings | `[PASS]` |
| 5.2 | Webhook HMAC verification, fail-closed, with replay guard. | `src/webhook-hmac.ts`, `src/didit.ts` | `[PASS]` |
| 5.3 | **No tamper-evident hash-chained audit log.** State transitions exist (`payment_state_transitions`) but are not hash-chained. | `src/db/schema.ts` `paymentStateTransitions` | `[FAIL]` |
| 5.4 | No RBAC / dual-control roles; no breach-notification workflow; no data deletion/export/consent handlers. | Absent | `[FAIL]` |
| 5.5 | Data residency (100% Libya) not pinned; Neon is `aws-eu-central-1` (Frankfurt). | `miirra-api/AGENTS.md` Neon region | `[FAIL]` (needs onshore migration) |

## 6. Consumer & Contract Rules (Art. 26, 28)

| # | Finding | Evidence | Tag |
|---|---|---|---|
| 6.1 | No complaint/dispute workflow, no dormancy handling, no account-closure state machine with a ≤3-business-day SLA. | Absent | `[FAIL]` |
| 6.2 | Refund path exists (consumer remedy) but is merchant/agent-initiated, not a self-serve complaint path. | `src/routes/payments.ts` refund | `[WARN]` |

---

## Summary

- **PASS:** 6
- **WARN:** 8
- **FAIL:** 8
- **NEEDS_LEGAL_OR_BANK_INPUT:** the commercial-bank settlement agreement, CBL filing package, onshore hosting, and licensing (Art. 5–7, 10, 12–14) — tracked in `02_cbl_readiness_dossier.md`.

The buildable `[FAIL]`/`[WARN]` items in code/config are addressed in Phase 2:
license/sandbox gate, currency+jurisdiction guard, account-tier segregation,
1:1 reconciliation, hash-chained audit log, AML/velocity hooks, consumer
lifecycle (complaints/dormancy/closure SLA), and consent/export handlers.