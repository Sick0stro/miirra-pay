# Miirra Pay & AMADAT — CBL Readiness Checklist for Coding Agents

> **Rule for Agent:** Do NOT mark an item `[x]` unless verified in code, config, tests, or repository artifacts—or explicitly tagged `[HUMAN_REQUIRED]` when dependent on legal, banking, or CBL actions outside the codebase.

## A. Licensing, Perimeter & Currency (Art. 2, 7, 8, 9(5))
- [ ] **A1.** Feature flag / gate prevents public or real-LYD Libyan onboarding unless CBL licensing or approved pilot/sandbox mode is explicitly enabled (`Art. 7`).
- [ ] **A2.** All domestic payment instruments, wallets, and settlement entries enforce **Libyan Dinar (`LYD`)** (`Art. 9(5), 10(4)`).
- [ ] **A3.** No unapproved foreign jurisdiction execution or external payment routing (`Art. 7, 9(5)`).
- [ ] **A4.** No crypto / virtual-asset references in Miirra Pay or AMADAT CBL regulatory/payment specs (`Art. 9(2)`).

## B. Payment-over-Mesh Integration & Offline P2P (Art. 9(8), 9(11), 15, 21(5))
- [ ] **B1.** Offline P2P transfers only draw from pre-funded, already-settled LYD balances—never mint unbacked credit offline (`Art. 15(2)-(3)`).
- [ ] **B2.** Offline transfer packets include cryptographic signatures, monotonic sequence counters, `tx_id`, sender/receiver IDs, `amount_lyd`, and prior-hash chaining.
- [ ] **B3.** Per-transaction, cumulative-offline, and offline-duration limits are enforced on-device and re-validated on sync.
- [ ] **B4.** Reconnect / Miirra Mesh sync handles out-of-order packets, retries, and double-spend/conflict attempts idempotently and quarantines conflicting claims for review.
- [ ] **B5.** `MeshPaymentTransportAdapter` isolates all networking/mesh/hole-punching inside Miirra Mesh (`mesh.miirra.com`) while keeping relays/endpoints onshore inside Libya (`Art. 9(5), 10(1), 21(5)`).

## C. Ledger, Aggregation Accounts & Settlement (Art. 12–15, LYPay / NAD)
- [ ] **C1.** Ledger models strict segregation between company operating/fee accounts and customer sub-aggregation + main settlement account (`حساب التسوية`) (`Art. 12`).
- [ ] **C2.** No spendable e-money is credited before final settlement / clearing confirmation (`Art. 15(2)-(3)`).
- [ ] **C3.** Automated reconciliation check verifies `total_e_money_liability == aggregation_accounts_balance` (`Art. 14(2)(3), 15(1)`).
- [ ] **C4.** `LYPay` / `NAD` / IBAN top-up, QR/P2P/P2M/M2M flows, and reversals/refunds are idempotent and logged with external reference IDs.

## D. KYC / AML, Security, Privacy & Consumer Rights (Art. 9(8), 16–28)
- [ ] **D1.** KYC/KYB verification gates active accounts; step-up verification triggers above `1,000 LYD` and AML/velocity alerts flag anomalies (`Art. 9(8)`).
- [ ] **D2.** Encryption in transit (`TLS 1.3` / E2EE P2P) and at rest, RBAC, and separation of duties / dual control for keys and settlement actions (`Art. 21–22`).
- [ ] **D3.** Tamper-evident hash-chained audit logs record financial and admin actions (`Art. 27(4)`).
- [ ] **D4.** Consent tracking, data export/deletion hooks (`Art. 18–20`), breach notification workflow (`Art. 24`), complaint flow, and account closure tracking within **3 business days** (`Art. 26(4)`).

## E. Eval Suite & Dossier Artifacts (`evals/cbl/`)
- [ ] **E1.** `evals/cbl/01_audit_report.md` generated with file paths and CBL article citations.
- [ ] **E2.** `evals/cbl/run_exhaustive_evals.py` passes all automated unit, integration, mesh-boundary, double-spend, settlement, and reconciliation tests.
- [ ] **E3.** `evals/cbl/02_cbl_readiness_dossier.md` populated with actual test counts, commands, and AMADAT details.

## F. `[HUMAN_REQUIRED]` Legal, Bank & CBL Filing Items (Art. 5–7, 10, 12–14)
- [ ] **F1.** Renew commercial registry extract (`2025/05/27` -> valid until `2026/05/27`) and confirm electronic payment activity scope in Articles / Ministry of Economy license (`Art. 5(3)(1–2), 8(7)`).
- [ ] **F2.** Confirm paid-in capital adequacy (`300,000 LYD` paid of `1,000,000 LYD` authorized) and appoint a Libyan national Data Officer (`Art. 5(3)(3–4)`).
- [ ] **F3.** Execute commercial bank settlement & aggregation account agreement (`حساب التسوية` + sub-aggregation accounts) and obtain CBL approval (`Art. 5(2), 12–14`).
- [ ] **F4.** Finalize 5-year business plan, fee schedule, SLAs, policies, Libya data center hosting, and CBL application / 6-month pilot readiness (`Art. 5–6, 10`).
