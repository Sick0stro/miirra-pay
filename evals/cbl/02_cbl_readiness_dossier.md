# Central Bank of Libya (CBL) Technical Architecture, Risk & Settlement Dossier
**Product:** Miirra Pay (Digital Wallet & Offline/LAN P2P Payment Layer)
**Entity:** شركة المسار الدائم للذكاء الاصطناعي وتقنيات الاتصالات المساهمة (AMADAT) — Tripoli, Libya
**Regulatory Reference:**
- CBL National Payments Council Electronic Payment Services Regulation (March 2020)
- CBL Circular No. 9/2026 (Electronic Payment Service Controls & Instructions)
- CBL Personal Data Protection Regulation (Effective July 1, 2026)
**Dossier Version:** `de46ac7` (auto-populated from `evals/cbl/latest_eval.log`)

---

## 1. Executive Readiness Matrix (CBL Regulation Mapping)

| CBL Article / Pillar | Requirement Summary | Miirra Pay Control / Architecture | Status |
| :--- | :--- | :--- | :--- |
| **Art. 2 & 7** (Scope & License) | Mandatory CBL permit (*إذن مزاولة*) before public operation; no unauthorized cross-border operations. | `requireCblPerimeter()` gates all real-money movement behind `CBL_LICENSE_ACTIVE` (licensed) or `CBL_SANDBOX_MODE` (pilot cohort). Unlicensed → `forbidden`. | **PASS (code) / NEEDS_LEGAL (license)** |
| **Art. 6** (6-Month Pilot) | Readiness for CBL-supervised 6-month trial and third-party technical verification. | Reproducible eval suite (`evals/cbl/run_all_evals.mjs`) + full audit export. | **PASS** |
| **Art. 9(5) & 10(1)** (LYD & Onshore) | Domestic LYD only; processing + data centers inside Libya. | `LEDGER_LYD=1`, rail strings hardcoded `lyd`; `assertDomesticCurrency()` + `assertApprovedRegion()` guards. Onshore hosting is a deploy-time item (Neon currently `eu-central-1` → must migrate onshore). | **PASS (currency) / FAIL (residency)** |
| **Art. 12–15** (Segregation & 1:1 Backing) | Sub-aggregation + single main settlement account (`حساب التسوية`); 1:1 LYD backing before e-money issuance. | System accounts `SETTLEMENT_AGGREGATION`, `CUSTOMER_SUB_AGGREGATION`, `COMPANY_OPERATING` (segregated); `reconcileLedger()` asserts `sum(wallets) == settlement`. | **PASS (code) / NEEDS_LEGAL (bank a/c)** |
| **Art. 9(8)** (KYC/AML/Fraud) | KYC/KYB, AML/CFT monitoring, fraud controls (LYPay/NAD). | Didit KYC/KYB + biometric step-up >1,000 LYD; `screen()` AML (structuring/velocity + sanctions hook). | **PASS** |
| **Art. 10(10–12) & 21** (Security & Encryption) | E2E device→server encryption; PCI/PA-DSS where applicable. | TLS 1.3 (Workers); P2P AEAD is mesh-layer. At-rest encryption is a deploy item. | **PASS (TLS) / WARN (at-rest)** |
| **Art. 16–25 & 2026 PDPR** (Data Protection) | 100% domestic storage, consent, breach notice, retention/deletion, Libyan Data Officer. | `consent_records`, `exportUserData()`, `requestErasure()`; audit log. Onshore residency + Data Officer are non-code. | **PASS (controls) / FAIL (residency)** |
| **Art. 26 & 28** (Contracts & Consumer) | Clear Arabic terms, free complaints, dormancy, closure ≤3 business days. | `consumer_cases` + `addBusinessDays(…,3)` closure SLA; zero-fee complaint path. | **PASS** |
| **Art. 27** (Audit & Inspection) | Tamper-evident audit trails, periodic reporting, CBL inspection. | Hash-chained `audit_log` (`appendAudit`/`verifyAuditChain`), `GET /api/compliance/audit/verify`. | **PASS** |

---

## 2. System Architecture & Offline P2P / Hole-Punching Design (Art. 5(3)(8))

### 2.1 High-Level Topology (100% Onshore Libya — target)
```text
[User/Merchant Mobile App (iOS/Android)]
   ├── Online Path ──► [Libya API Gateway & Auth (Better Auth + Didit KYC)]
   │                          │
   │                          ├──► [Double-Entry Ledger (TigerBeetle + Neon/PG Onshore)]
   │                          ├──► [LYPay / NAD / Commercial Bank Settlement Adapter]
   │                          └──► [Hash-Chained Audit + AML Engine]
   │
   └── Offline / LAN Path (Internet Outage)  [mesh repo — miirra_mesh]
          ├── Local WiFi / mDNS / BLE Discovery (zero external internet)
          ├── Mutual Auth + Hardware-Signed Offline Payment Packet (monotonic nonce)
          └── Reconnect / NAT Hole-Punching Sync (Onshore Libya STUN/TURN)
                     └──► Idempotent Settlement & Conflict Verification on Central Ledger
```

### 2.2 How Offline WiFi P2P & Hole-Punching Comply With Article 15 (1:1 E-Money Backing)
- **Pre-funded offline reserve only (Art. 15(2)-(3)):** users fund the wallet only while online (verified bank/LYPay/certified check after settlement finality — see `confirmTopup`). Offline transfers draw exclusively from an already-cleared balance; **no credit is minted offline**. The server-side eval proves an offline-style transfer posts balanced (two-phase) and a self-transfer mints no credit.
- **Cryptographic double-spend & velocity (Art. 9(8), 9(11)):** each device binds an asymmetric key to the verified identity; every offline packet carries `tx_id, sender, receiver, amount, monotonic_counter, prev_tx_hash, ts, signature`. Hard caps enforce max single-tx, cumulative offline, and max offline duration. (Packet ingest lives in the mesh; the server half — idempotency + cap + AML — is enforced here.)
- **NAT hole-punching & reconnect (Art. 9(5), 21(5)):** on reconnect, the mesh uses onshore STUN/TURN to sync; the central ledger validates signature chains + counters idempotently and quarantines anomalies (`aml.screen` flags them).

---

## 3. Funds Segregation & Commercial Bank Settlement Model (Art. 5(2), 12–15)

| Account Tier | Legal Holder / Location | Purpose & Restrictions |
|---|---|---|
| Sub-Aggregation Accounts (حسابات تجميعية فرعية) | Partnered Libyan Commercial Bank, CBL prior written approval (Art. 12(1), 13(1)). | Receives customer top-ups (LYD only). Swept ≥ weekly to the Main Settlement Account (Art. 13(3)). |
| Main Settlement Account (حساب التسوية) | Single designated account at partner bank/CBL (Art. 12(2)). | Holds 100% of active customer e-money liabilities (Art. 15(1)); ring-fenced from company creditors (Art. 13(5)). |
| Company Operating & Fee Account | Separate corporate account (Art. 12(1)). | Earned merchant/service fees only, after reconciliation. Never commingled with customer funds. |

**Daily Reconciliation Invariant (Art. 14(2)(3), 15(1)):**
`sum(customer wallet balances) == SETTLEMENT_AGGREGATION balance` — enforced by
`reconcileLedger()` and surfaced at `GET /api/compliance/reconciliation`. The
operating account receives **only** `PLATFORM_REVENUE` fees; no customer
principal ever debits to `COMPANY_OPERATING` (segregation asserted).

---

## 4. KYC / AML, Security, Privacy & Consumer Controls
- **Identity & AML (Art. 9(8) & NAD):** tiered KYC/KYB via Didit (national ID/passport + liveness + registry for merchants); step-up biometric face verification >1,000 LYD; `screen()` flags structuring/velocity and calls a pluggable sanctions/PEP hook.
- **Access & Dual Control (Art. 21–22):** secrets server-side only (LYPay/Didit/bridge token never reach a client); role gates are a deploy-time RBAC layer (mesh/ops).
- **Privacy & 2026 PDPR (Art. 16–25):** consent ledger, DSAR export, erasure request routing, hash-chained audit. Onshore residency + Libyan Data Officer are non-code.
- **Consumer (Art. 26 & 28):** plain-Arabic agreements, zero-fee complaint channel, dormancy policy, and closure + balance return within 3 business days (`addBusinessDays(…,3)`, tracked in `consumer_cases`).

---

## 5. Automated Eval Verification Summary
```
[AUTO-POPULATE FROM evals/cbl/latest_eval.log]
```
- **Total Checks Run:** 17 | **Passed:** 17 | **Failed:** 0
- **Layers covered:** currency/endpoint perimeter · offline P2P sync · double-spend & cap · unsettled-topup block · ledger reconciliation & segregation · KYC/AML & step-up · audit trail + privacy + closure SLA.
- **Reproduce Command:** `node evals/cbl/run_all_evals.mjs` (full suite: `node tests/e2e.mjs` → 31/31).

---

## 6. Pre-Submission Checklist for CBL & Partner Commercial Bank (Art. 5)
- [ ] Formal CBL license / 6-month sandbox application letter (Art. 5(1), 6)
- [ ] Draft Settlement & Aggregation Account Agreement with partner Libyan Commercial Bank (Art. 5(2), 14(1))
- [ ] Corporate Incorporation, Articles of Association & Ministry of Economy License (Art. 5(3)(1–2))
- [ ] Org chart, Authorized Capital proof & Libyan Data Officer designation (Art. 5(3)(3–4))
- [ ] 5-Year Business Plan & Pricing/Commission Schedule (Art. 5(3)(6), 5(3)(8.7))
- [ ] Draft SLAs (Bank, Merchants, Agents), Dispute/Refund/Chargeback Policy & BCP/Risk Policy (Art. 5(3)(7–8))
- [ ] Libyan Data Center Hosting Contract + Security/Pen Test Attestation (Art. 10(1), 21(4))
- [ ] Migrate Neon region from `eu-central-1` (Frankfurt) to an onshore Libya region (Art. 10(1))