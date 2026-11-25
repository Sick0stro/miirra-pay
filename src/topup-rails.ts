/**
 * Modular top-up rails (no static 23-bank button wall).
 *
 * Top-up rails are feature-gated and listed dynamically so the client renders
 * only what is actually integrated. A Libyan bank that is not yet wired shows
 * an explicit `COMING_SOON` state rather than a dead button. This keeps the UX
 * honest (nothing looks live that isn't) and lets banks be enabled by config
 * without a client rebuild.
 *
 * Rail integration is a deploy-time concern (each bank = a credential + a
 * clearing path). The `INTEGRATED_RAILS` set is the single source of truth; a
 * rail not in it is `coming_soon`.
 */

export type TopUpRail =
  | 'bank_transfer' // generic IBAN/bank transfer to the platform receiving account
  | 'agent_cash_in' // cash-in at a Miirra agent (Regular/Super Agent)
  | 'peer_mesh_receive' // receive from another user over Miirra Mesh (offline-capable)
  | 'lypay_instant' // LYPay instant credit (when wired)
  | string; // specific banks: 'nuran', 'jumhouria', ... (coming_soon until integrated)

export type RailStatus = 'integrated' | 'coming_soon' | 'disabled';

export type RailInfo = {
  id: TopUpRail;
  label: string;
  status: RailStatus;
  /** Shown to the user when coming_soon (e.g. "Launching Q2 2026"). */
  note?: string;
};

/**
 * The rails Miirra Pay knows about. `INTEGRATED_RAILS` is the allowlist that is
 * actually live; everything else renders as `coming_soon`.
 */
const INTEGRATED_RAILS = new Set<TopUpRail>(['bank_transfer', 'peer_mesh_receive']);

/** The full rail catalog shown to the client (integrated first, then coming soon). */
export const RAIL_CATALOG: RailInfo[] = [
  { id: 'bank_transfer', label: 'Bank transfer (IBAN)', status: 'integrated' },
  { id: 'peer_mesh_receive', label: 'Receive from a Miirra user (Mesh)', status: 'integrated' },
  { id: 'agent_cash_in', label: 'Cash-in at a Miirra agent', status: 'coming_soon', note: 'Rolling out with the agent network' },
  { id: 'lypay_instant', label: 'LYPay instant', status: 'coming_soon', note: 'Pending CBL LYPay enablement' },
  // Named Libyan banks — all coming_soon until individually integrated.
  { id: 'nuran', label: 'Nuran Bank', status: 'coming_soon' },
  { id: 'jumhouria', label: 'Jumhouria Bank', status: 'coming_soon' },
  { id: 'sicap', label: 'Sicap Bank', status: 'coming_soon' },
  { id: 'wafa', label: 'Wafa Bank', status: 'coming_soon' },
];

/** Resolve the client-facing status for a rail id. */
export function railStatus(id: TopUpRail): RailStatus {
  if (INTEGRATED_RAILS.has(id)) return 'integrated';
  if (RAIL_CATALOG.some((r) => r.id === id)) return 'coming_soon';
  return 'disabled';
}

/** List rails for the client, integrated first. */
export function listRails(): RailInfo[] {
  return [...RAIL_CATALOG].sort((a, b) => {
    if (a.status === 'integrated' && b.status !== 'integrated') return -1;
    if (b.status === 'integrated' && a.status !== 'integrated') return 1;
    return 0;
  });
}

/** True when a rail can actually move money right now. */
export function isRailLive(id: TopUpRail): boolean {
  return INTEGRATED_RAILS.has(id);
}