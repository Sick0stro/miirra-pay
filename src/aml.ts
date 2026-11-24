/**
 * AML / fraud screening hooks (CBL Art. 9(8), LYPay rules).
 *
 * Lightweight, deterministic checks that flag (not block, unless configured)
 * suspicious patterns before a transfer proceeds. A real deployment would call
 * a sanctions/PEP provider here; this module provides the hook interface and
 * the structuring/velocity rules the CBL review expects, so a provider can be
 * dropped in behind `screen()`.
 */

import { sql } from 'drizzle-orm';
import type { Db } from './db';

export type AmlFlag = {
  rule: string;
  severity: 'low' | 'medium' | 'high';
  detail: string;
};

export type AmlResult = {
  flagged: boolean;
  /** When true, the caller should refuse the transfer pending review. */
  block: boolean;
  flags: AmlFlag[];
};

/** A sanctions/PEP provider hook. Default: none (no external screening). */
export type SanctionsScreen = (params: { userId: string; amountMinor: number }) => Promise<AmlFlag[]>;

/**
 * Screen a transfer for AML/fraud signals. Runs:
 *  - structuring: multiple just-under-cap transfers in a short window.
 *  - velocity: unusually high cumulative outflow vs. the user's baseline.
 *  - a pluggable sanctions/PEP hook.
 *
 * Returns flags; `block` is true only when a high-severity rule matches (so a
 * low/medium flag is logged for review but does not stop a legitimate payment).
 */
export async function screen(params: {
  db: Db;
  userId: string;
  amountMinor: number;
  perTransferCapMinor: bigint;
  dailyCapMinor: bigint;
  sanctions?: SanctionsScreen;
  now?: number;
}): Promise<AmlResult> {
  const { db, userId, amountMinor, perTransferCapMinor, dailyCapMinor } = params;
  const now = params.now ?? Date.now();
  const flags: AmlFlag[] = [];

  // 1. Structuring: amount is just under the per-transfer cap AND the user has
  //    several transfers in the last hour clustering near the cap.
  const justUnderCap = BigInt(amountMinor) <= perTransferCapMinor && BigInt(amountMinor) >= (perTransferCapMinor * 9n) / 10n;
  if (justUnderCap) {
    const recent = await db.execute(sql`
      SELECT COUNT(*) AS c FROM miirra_pay.payment_transactions
      WHERE idempotency_key LIKE 'wallet:%' OR idempotency_key LIKE 'withdraw:%'
        AND principal_minor >= ${Number((perTransferCapMinor * 9n) / 10n)}
        AND created_at >= ${now - 60 * 60 * 1000}
    `);
    const count = Number((recent.rows[0] as { c: string | number } | undefined)?.c ?? 0);
    if (count >= 3) {
      flags.push({ rule: 'structuring', severity: 'high', detail: `${count} near-cap transfers in the last hour` });
    }
  }

  // 2. Velocity: cumulative outflow in the last hour exceeds 50% of the daily
  //    cap (a fast cash-out loop signal).
  const vel = await db.execute(sql`
    SELECT COALESCE(SUM(principal_minor + fee_minor), 0) AS spent FROM miirra_pay.payment_transactions
    WHERE (idempotency_key LIKE 'wallet:%' OR idempotency_key LIKE 'withdraw:%')
      AND created_at >= ${now - 60 * 60 * 1000}
  `);
  const spentLastHour = Number((vel.rows[0] as { spent: string | number } | undefined)?.spent ?? 0);
  if (BigInt(spentLastHour) > dailyCapMinor / 2n) {
    flags.push({ rule: 'velocity', severity: 'medium', detail: `${spentLastHour} minor units in the last hour (> 50% daily cap)` });
  }

  // 3. Pluggable sanctions/PEP hook.
  if (params.sanctions) {
    const external = await params.sanctions({ userId, amountMinor });
    flags.push(...external);
  }

  const block = flags.some((f) => f.severity === 'high');
  return { flagged: flags.length > 0, block, flags };
}