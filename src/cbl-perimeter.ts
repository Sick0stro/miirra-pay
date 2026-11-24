/**
 * CBL regulatory perimeter — license/sandbox gating, currency enforcement,
 * and jurisdiction/endpoint constraints.
 *
 * Implements the Article 2/7/8/9(5)/10(1) guardrails from the CBL Electronic
 * Payment Services Regulation (March 2020):
 *  - Real-money Libyan onboarding is gated behind an explicit CBL
 *    license/sandbox flag. Without it, only the sandbox cohort may transact,
 *    and live movement is refused.
 *  - Domestic instruments are LYD-only; a non-LYD currency on a domestic rail
 *    call is rejected (Art. 9(5)).
 *  - Execution is pinned to approved Libya infrastructure; a non-approved
 *    region/host can be refused (Art. 10(1)).
 *
 * These are enforced SERVER-SIDE. The client never sees the flags.
 */

import { forbidden } from './errors';

/** License / sandbox operating mode, read from the worker env. */
export type CblMode = 'sandbox' | 'licensed' | 'unlicensed';

export function cblModeFromEnv(env: {
  CBL_LICENSE_ACTIVE?: string;
  CBL_SANDBOX_MODE?: string;
}): CblMode {
  if (env.CBL_LICENSE_ACTIVE === '1') return 'licensed';
  if (env.CBL_SANDBOX_MODE === '1') return 'sandbox';
  return 'unlicensed';
}

/**
 * Gate a real-money action behind the license/sandbox perimeter.
 *
 *  - licensed  → allowed
 *  - sandbox   → allowed, but only for allow-listed sandbox users (the pilot
 *                cohort). Non-cohort users are refused.
 *  - unlicensed→ refused entirely (no real-money movement without a license or
 *                an explicit sandbox).
 *
 * `sandboxUserIds` is a comma-separated allowlist in env; empty means "any
 * authed user in sandbox" (dev convenience) — production MUST set it.
 */
export function requireCblPerimeter(params: {
  env: { CBL_LICENSE_ACTIVE?: string; CBL_SANDBOX_MODE?: string; CBL_SANDBOX_USER_IDS?: string };
  userId: string;
}): { mode: CblMode } {
  const mode = cblModeFromEnv(params.env);
  if (mode === 'licensed') return { mode };
  if (mode === 'sandbox') {
    const allow = (params.env.CBL_SANDBOX_USER_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (allow.length === 0 || allow.includes(params.userId)) return { mode };
    throw forbidden('Not in the CBL sandbox cohort');
  }
  // unlicensed: no real-money movement.
  throw forbidden('Payments are not enabled (no CBL license or sandbox active)');
}

/** The only currency a domestic payment instrument may carry (Art. 9(5)). */
export const DOMESTIC_CURRENCY = 'LYD' as const;

/** Throw if a domestic rail call carries a non-LYD currency. */
export function assertDomesticCurrency(currency: string | undefined | null): asserts currency is string {
  if (!currency) return; // caller defaults to LYD
  if (currency.toUpperCase() !== DOMESTIC_CURRENCY) {
    throw forbidden(`Only ${DOMESTIC_CURRENCY} is supported on domestic payment instruments`);
  }
}

/**
 * Approved Libya region allowlist (Art. 10(1)). A deployment region outside
 * this set means data/processing may be off-shore — refuse to operate. Read
 * from env so the check is meaningful in prod without hardcoding a cloud region.
 */
export function assertApprovedRegion(env: { CBL_APPROVED_REGION?: string; CLOUDFLARE_REGION?: string }): void {
  const approved = env.CBL_APPROVED_REGION;
  if (!approved) return; // not configured — dev/local; prod MUST set
  const actual = env.CLOUDFLARE_REGION;
  if (actual && actual !== approved) {
    throw forbidden('Execution region is not CBL-approved');
  }
}