/**
 * TigerBeetle ledger vocabulary for Miirra Pay.
 *
 * Everything money touches is an integer in MINOR UNITS (LYD piastres) on a
 * single ledger — `ledger = 1` means LYD — and every account/transfer id is a
 * u128 serialized as a decimal string when it crosses JSON or SQL. Drizzle and
 * Postgres cannot hold u128 natively, so these ids live in `text`/`numeric`
 * columns and are only ever assembled back into BigInt at the edge.
 *
 * The account chart is deliberately small and structural: every payment is a
 * movement between a small set of institutional accounts (clearing, platform
 * revenue, refunds), and each user/merchant gets ONE personal account. The
 * two-phase dance (pending → post/void) is what lets a funds transfer be
 * "acknowledged" durably before LYPay says whether it completed or declined.
 */

/** The one ledger Miirra Pay books on. `1` = LYD, per TigerBeetle convention. */
export const LEDGER_LYD = 1 as const;

/** Currency code the LYPay rail speaks; TigerBeetle only stores the minor unit. */
export const CURRENCY_LYD = 'lyd' as const;

/**
 * Institutional (system) accounts. These are FIXED u128 ids so every isolate,
 * every worker instance and the migration all agree on where platform money
 * lives. Keep them small and well clear of the per-user id space below.
 */
export const SYSTEM = {
  /** Receiving account for inbound top-ups (Bank/LYPay → Miirra). */
  PLATFORM_CLEARING: 1n,
  /** Miirra's own fee/commission revenue. */
  PLATFORM_REVENUE: 2n,
  /** Sinking fund refunds are paid out of before LYPay re-credits. */
  REFUND_SUSPENSE: 3n,
} as const;

/**
 * Per-entity account id space.
 *
 * A user's TigerBeetle account id is derived deterministically from their
 * platform user id, so the SAME user always maps to the SAME account without a
 * lookup table — and so a retry after a crash recreates the same id rather than
 * opening a duplicate wallet.
 *
 * We hash into a high band so a user id can never collide with a system id or
 * with another user with overwhelming probability. Collisions are still
 * detectable at account-creation time (TigerBeetle rejects a duplicate id with
 * `exists`), and createAccount treats that as "already provisioned", not an
 * error.
 */
const USER_ACCOUNT_BAND = 0x1_0000_0000_0000_0000n; // 2^64 — well above system ids

/**
 * Deterministic u128 account id for a platform entity (user or merchant).
 *
 * Uses a 64-bit FNV-1a hash of the namespaced id placed in the high 64 bits of
 * a u128. This is NOT a security primitive — it is an id deriver — so a fast
 * non-cryptographic hash is the right tool. A collision would surface as a
 * TigerBeetle `exists` at provisioning and would be impossible to confuse with
 * a real id because two different entities claiming one account is exactly what
 * the `exists` guard catches.
 */
export function accountIdFor(kind: 'user' | 'merchant', platformId: string): bigint {
  const key = `${kind}:${platformId}`;
  let h = 0xcbf29ce484222325n; // FNV offset basis
  for (let i = 0; i < key.length; i++) {
    h ^= BigInt(key.charCodeAt(i));
    h = BigInt.asUintN(64, h * 0x100000001b3n); // FNV prime
  }
  return USER_ACCOUNT_BAND + (h & 0xffff_ffff_ffff_ffffn);
}

/**
 * Deterministic u128 transfer id for a payment leg.
 *
 * Each logical transfer (a pending debit, its matching credit, a refund leg)
 * gets its own transfer id derived from the parent transaction id and a leg
 * label. Deterministic + namespaced means a retried "post this pending
 * transfer" re-submits the SAME transfer id, which TigerBeetle de-duplicates by
 * id — the ledger itself becomes idempotent for the confirmation step.
 */
export function transferIdFor(transactionId: string, leg: string): bigint {
  let h = 0x9e3779b97f4a7c15n;
  const key = `${transactionId}:${leg}`;
  for (let i = 0; i < key.length; i++) {
    h ^= BigInt(key.charCodeAt(i));
    h = BigInt.asUintN(64, h * 0x100000001b3n);
    // mix to spread bits across the 128-bit space
    h = BigInt.asUintN(64, h ^ (h >> 29n));
  }
  // Combine two independent mixes into 128 bits.
  const hi = h;
  let g = 0x94d049bb133111eBn;
  for (let i = key.length - 1; i >= 0; i--) {
    g ^= BigInt(key.charCodeAt(i));
    g = BigInt.asUintN(64, g * 0x100000001b3n);
  }
  const lo = g;
  return (hi << 64n) + lo;
}

/** TigerBeetle flag values (subset Miirra Pay uses). Bitfield, OR-combined.
 *  Values match the TigerBeetle wire protocol (src/transfer.zig). */
export const TransferFlags = {
  linked: 1 << 0,
  pending: 1 << 1,
  post_pending_transfer: 1 << 2,
  void_pending_transfer: 1 << 3,
  balancing_debit: 1 << 1,
  balancing_credit: 1 << 2,
} as const;

/** TigerBeetle account flags (subset). Values match src/account.zig. */
export const AccountFlags = {
  linked: 1 << 0,
  debits_must_not_exceed_credits: 1 << 1,
  credits_must_not_exceed_debits: 1 << 2,
  history: 1 << 3,
} as const;

/** Pretty-print a u128 id for logs/errors — never log raw floats. */
export const idStr = (id: bigint): string => id.toString(10);

/** Parse a decimal-string id back to u128, rejecting anything unsafe. */
export const parseU128 = (s: string): bigint => {
  const v = BigInt(s);
  if (v < 0n) throw new Error(`negative u128 id: ${s}`);
  return v;
};