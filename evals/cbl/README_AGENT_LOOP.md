# Master Agent Instructions — Miirra Pay & AMADAT CBL Build + Eval Loop

Run this loop end-to-end inside your repo:
1. Read `evals/cbl/cbl_checklist.md`, `evals/cbl/03_amadat_entity_checklist.md`, and `evals/cbl/miirra_pay_mesh_integration.md`.
2. Audit the Miirra Pay & Miirra Mesh codebase and write `evals/cbl/01_audit_report.md`.
3. Implement `MeshPaymentTransportAdapter` (leaving all networking/hole-punching/relays to Miirra Mesh) and patch any missing CBL payment/ledger/KYC/audit/closure guardrails.
4. Wire `evals/cbl/run_exhaustive_evals.py` to your production modules and run `python evals/cbl/run_exhaustive_evals.py --strict` until `failed == 0`.
5. Update `evals/cbl/cbl_checklist.md` and populate `evals/cbl/02_cbl_readiness_dossier.md`. Keep legal/banking items `[F1–F4]` flagged `[HUMAN_REQUIRED]`.
