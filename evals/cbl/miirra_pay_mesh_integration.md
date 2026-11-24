# Task: Integrate Miirra Pay With Miirra Mesh Transport & Relay Layer

Keep all underlying network transport, peer discovery, wireless links, relays, and hole-punching owned by **Miirra Mesh** (`mesh.miirra.com`).
Do NOT build custom network sockets, wireless drivers, or raw relay routing inside Miirra Pay. Instead, define and implement a clean **Payment-over-Mesh boundary** where Miirra Pay:
1. Consumes a transport/sync adapter exposed by Miirra Mesh.
2. Enforces all **Miirra Pay & CBL payment rules** (LYD denomination, pre-funded balance reservation, cryptographic payment signing, monotonic counters, offline caps, double-spend detection, idempotent settlement, and hash-chained audit logs) at the payment layer.

## Step 1: Inspect Existing Miirra Mesh & Miirra Pay Interfaces
- Locate Miirra Mesh node/client APIs, events, message/frame envelopes, and connection/sync state hooks in the repo.
- Locate Miirra Pay wallet, ledger, offline-payment signing/verification, reconciliation, and audit modules.
- Document the exact boundary in `evals/cbl/mesh_payment_adapter_spec.md` (what Miirra Mesh provides vs. what Miirra Pay signs, validates, and settles).

## Step 2: Implement the `MeshPaymentTransportAdapter` in Miirra Pay
Build a clean adapter layer (`payments/mesh_adapter.py` or `.ts` matching your stack) with:
- `send_signed_payment_frame(peer_id, signed_payload)` -> delegates payload delivery over Miirra Mesh (works over local/offline mesh/LAN and syncs when mesh connectivity reaches upstream/ledger).
- `on_payment_frame_received(handler)` -> receives inbound payment frames/receipts from Miirra Mesh and passes them to Miirra Pay's payment verifier & ledger queue.
- `on_connectivity_state_change(state)` -> reacts to mesh online/offline/syncing transitions.
- Strict separation: Miirra Mesh moves encrypted envelopes/frames; Miirra Pay verifies signatures, sequence numbers, `LYD` currency, offline limits, double-spend conflicts, and ledger finality.

## Step 3: Add Tests for the Mesh <-> Pay Boundary
Add tests to `evals/cbl/run_exhaustive_evals.py` using a mock/stubbed `MiirraMesh` interface that verifies:
1. Payment payloads travel through `MeshPaymentTransportAdapter` without leaking raw network/socket logic into payment/ledger domain code.
2. Offline mesh delivery + reconnect sync delivers signed payment frames idempotently and reconciles balances cleanly.
3. Corrupted/tampered or duplicate frames arriving over the mesh adapter are rejected/quarantined by Miirra Pay without corrupting ledger state.
4. Audit logs record payment settlement and conflict events cleanly (`Art. 27(4)`).

## Step 4: Run Evals & Update Dossier
- Run the full eval suite (`python evals/cbl/run_exhaustive_evals.py`) and update `evals/cbl/cbl_checklist.md` and `evals/cbl/02_cbl_readiness_dossier.md` with the new adapter tests and results.
