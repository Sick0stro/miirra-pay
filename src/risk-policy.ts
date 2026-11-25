/**
 * Miirra Risk Management Policy v1.0 (Approved 15/01/2026; annual review
 * 15/01/2027) — executable configuration.
 *
 * This is the SINGLE source of truth for the CBL risk tiers, agent types, the
 * Africa/Tripoli daily-limit reset boundary, and the incident-escalation SLA.
 * Every money path reads limits from here; no tier/limit is a literal at a call
 * site, and there is NO manual override without Board & Regulatory approval
 * (there is no override code path at all — the values are constants).
 *
 * Policy scope note: the policy doc still carries `[organisation name]` /
 * `[Company Name]` placeholders and a couple of draft sections; those are
 * flagged in the CBL dossier (F-tier) as editorial cleanups, not code. The
 * numeric controls below are taken as authoritative.
 */

import { MINOR_UNITS_PER_MAJOR } from './money';

const L = (lyd: number): bigint => BigInt(Math.round(lyd * MINOR_UNITS_PER_MAJOR));

/** KYC tiers from the policy. Limits are system-enforced constants. */
export type KycTier = 'SDD' | 'CDD' | 'EDD';

export type TierLimits = {
  tier: KycTier;
  /** Max single top-up (minor units). */
  maxSingleTopUpMinor: bigint;
  /** Max wallet balance (minor units). */
  maxBalanceMinor: bigint;
  /** Max daily top-up count. */
  maxDailyTopUpCount: number;
  /** Max daily P2P tx count. */
  maxDailyP2pCount: number;
  /** Max withdrawal (minor units). */
  maxWithdrawalMinor: bigint;
  /** Max single P2P transfer (minor units). */
  maxP2pTransferMinor: bigint;
};

/**
 * Tier table (Risk Policy v1.0). SDD = individual, CDD = professional,
 * EDD = business. No manual override exists — Board + Regulatory approval would
 * be a policy change (a new version here), not a runtime flag.
 */
export const TIER_LIMITS: Record<KycTier, TierLimits> = {
  SDD: {
    tier: 'SDD',
    maxSingleTopUpMinor: L(300),
    maxBalanceMinor: L(3_000),
    maxDailyTopUpCount: 5,
    maxDailyP2pCount: 5,
    maxWithdrawalMinor: L(3_000),
    maxP2pTransferMinor: L(150),
  },
  CDD: {
    tier: 'CDD',
    maxSingleTopUpMinor: L(1_000),
    maxBalanceMinor: L(20_000),
    maxDailyTopUpCount: 5,
    maxDailyP2pCount: 5,
    maxWithdrawalMinor: L(20_000),
    maxP2pTransferMinor: L(1_000),
  },
  EDD: {
    tier: 'EDD',
    maxSingleTopUpMinor: L(10_000),
    maxBalanceMinor: L(50_000),
    maxDailyTopUpCount: 5,
    maxDailyP2pCount: 5,
    maxWithdrawalMinor: L(50_000),
    maxP2pTransferMinor: L(10_000),
  },
};

/** Get a tier's limits (defaults to SDD for an unverified user). */
export function tierLimits(tier: KycTier | undefined | null): TierLimits {
  return TIER_LIMITS[tier ?? 'SDD'] ?? TIER_LIMITS.SDD;
}

// ── Agent tiers ──────────────────────────────────────────────────────────────

export type AgentTier = 'regular' | 'super';

export type AgentPolicy = {
  tier: AgentTier;
  /** Which KYC tiers this agent may onboard. */
  allowedKycTiers: KycTier[];
  /** Whether this agent must track agent float (pre-funded cash float). */
  tracksFloat: boolean;
  /** Whether this agent requires liquidity monitoring. */
  liquidityMonitoring: boolean;
};

export const AGENT_POLICY: Record<AgentTier, AgentPolicy> = {
  // Regular Agent: SDD only, float tracking.
  regular: { tier: 'regular', allowedKycTiers: ['SDD'], tracksFloat: true, liquidityMonitoring: false },
  // Super Agent: CDD/EDD, liquidity monitoring.
  super: { tier: 'super', allowedKycTiers: ['CDD', 'EDD'], tracksFloat: true, liquidityMonitoring: true },
};

// ── Africa/Tripoli daily-limit reset boundary ─────────────────────────────────

/** The Libya calendar timezone (UTC+2, no DST). */
export const TRIPOLI_TZ = 'Africa/Tripoli';
/** UTC offset for Africa/Tripoli in minutes (UTC+2). */
export const TRIPOLI_UTC_OFFSET_MIN = 120;

/**
 * Start-of-day (Africa/Tripoli) for the UTC instant `utcMs`, returned as a UTC
 * ms timestamp. The Tripoli day boundary is 00:00 local = 22:00 UTC the
 * PREVIOUS calendar day. Internally all timestamps are UTC; this converts the
 * boundary so "daily" counts reset at 00:00:00 Africa/Tripoli.
 */
export function tripoliStartOfDay(utcMs: number): number {
  const shifted = utcMs + TRIPOLI_UTC_OFFSET_MIN * 60_000;
  const dayStartShifted = Math.floor(shifted / 86_400_000) * 86_400_000;
  return dayStartShifted - TRIPOLI_UTC_OFFSET_MIN * 60_000;
}

/**
 * True when `nowMs` is at/after the next Tripoli day boundary relative to
 * `lastResetMs` — i.e. the daily counters should reset.
 */
export function isNewTripoliDay(nowMs: number, lastResetMs: number): boolean {
  return tripoliStartOfDay(nowMs) > tripoliStartOfDay(lastResetMs);
}

// ── Incident escalation SLA (Risk Policy) ─────────────────────────────────────

export type IncidentSeverity = 'moderate' | 'high' | 'extreme';

export type EscalationTarget = {
  severity: IncidentSeverity;
  /** Who is notified. */
  notify: string;
  /** Deadline for notification (ms), or null for "immediate". */
  deadlineMs: number | null;
  /** Whether a Root Cause Analysis is required. */
  rcaRequired: boolean;
};

export const ESCALATION: Record<IncidentSeverity, EscalationTarget> = {
  moderate: { severity: 'moderate', notify: 'ops', deadlineMs: null, rcaRequired: false },
  // High: Board + RCA within 24h.
  high: { severity: 'high', notify: 'board', deadlineMs: 24 * 3600_000, rcaRequired: true },
  // Extreme: CBL notification + RCA within 1h.
  extreme: { severity: 'extreme', notify: 'cbl', deadlineMs: 1 * 3600_000, rcaRequired: true },
};

/** Map a risk score (0–100) to an escalation target, aligning with the policy. */
export function escalationForScore(score: number): EscalationTarget {
  if (score >= 80) return ESCALATION.extreme;
  if (score >= 50) return ESCALATION.high;
  return ESCALATION.moderate;
}

// ── Enforcement helpers ───────────────────────────────────────────────────────

export type TierCheck =
  | { ok: true; tier: KycTier }
  | { ok: false; reason: string; code: string };

/** Check a single top-up amount against the tier cap. */
export function checkTopUp(tier: KycTier, amountMinor: bigint): TierCheck {
  const lim = tierLimits(tier);
  if (amountMinor > lim.maxSingleTopUpMinor) {
    return { ok: false, reason: `Top-up ${amountMinor} exceeds single-top-up cap for ${tier}`, code: 'exceeds_topup_cap' };
  }
  return { ok: true, tier };
}

/** Check a wallet balance top-up won't exceed the tier's max balance. */
export function checkBalance(tier: KycTier, currentBalanceMinor: bigint, topUpMinor: bigint): TierCheck {
  const lim = tierLimits(tier);
  if (currentBalanceMinor + topUpMinor > lim.maxBalanceMinor) {
    return { ok: false, reason: `Balance would exceed ${tier} max balance`, code: 'exceeds_balance_cap' };
  }
  return { ok: true, tier };
}

/** Check a P2P transfer amount against the tier cap. */
export function checkP2pTransfer(tier: KycTier, amountMinor: bigint): TierCheck {
  const lim = tierLimits(tier);
  if (amountMinor > lim.maxP2pTransferMinor) {
    return { ok: false, reason: `P2P transfer ${amountMinor} exceeds ${tier} cap`, code: 'exceeds_p2p_cap' };
  }
  return { ok: true, tier };
}

/** Check a withdrawal amount against the tier cap. */
export function checkWithdrawal(tier: KycTier, amountMinor: bigint): TierCheck {
  const lim = tierLimits(tier);
  if (amountMinor > lim.maxWithdrawalMinor) {
    return { ok: false, reason: `Withdrawal ${amountMinor} exceeds ${tier} cap`, code: 'exceeds_withdrawal_cap' };
  }
  return { ok: true, tier };
}

/** Check daily count against the tier cap (top-ups or P2P). */
export function checkDailyCount(tier: KycTier, kind: 'topup' | 'p2p', usedCount: number): TierCheck {
  const lim = tierLimits(tier);
  const cap = kind === 'topup' ? lim.maxDailyTopUpCount : lim.maxDailyP2pCount;
  if (usedCount >= cap) {
    return { ok: false, reason: `${kind} daily count ${usedCount} reached ${tier} cap ${cap}`, code: 'exceeds_daily_count' };
  }
  return { ok: true, tier };
}

/** Check an agent may onboard a given KYC tier. */
export function checkAgentMayOnboard(agent: AgentTier, tier: KycTier): TierCheck {
  const pol = AGENT_POLICY[agent];
  if (!pol.allowedKycTiers.includes(tier)) {
    return { ok: false, reason: `${agent} agent may not onboard ${tier}`, code: 'agent_tier_forbidden' };
  }
  return { ok: true, tier };
}