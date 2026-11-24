/**
 * Runtime wiring — build a configured LedgerService and rail limits from env.
 *
 * Every route needs the same two things: a LedgerService (with the configured
 * pending-timeout) and the effective RailLimits. Keeping that construction in
 * one place means the timeout, the bridge mode, and the caps can never drift
 * between the payments, top-up, wallet, and webhook handlers.
 */

import type { AppEnv } from './env';
import { createLedgerClient } from './ledger';
import { LedgerService } from './ledger-service';
import { DEFAULT_RAIL_LIMITS, type RailLimits } from './money';

/** Build the TigerBeetle bridge config from env (mock unless a bridge is set). */
export function ledgerConfig(env: AppEnv['Bindings']) {
  const useHttp = env.LEDGER_MODE === 'http' || !!env.LEDGER_BRIDGE_URL;
  return {
    baseUrl: env.LEDGER_BRIDGE_URL ?? 'http://127.0.0.1:8788',
    token: env.LEDGER_BRIDGE_TOKEN ?? '',
    mode: (useHttp ? 'http' : 'mock') as 'http' | 'mock',
  };
}

/** Build a LedgerService with the configured pending-transfer timeout. */
export function ledgerFromEnv(env: AppEnv['Bindings']): LedgerService {
  const secs = Number(env.LEDGER_PENDING_TIMEOUT_SECONDS ?? '0');
  return new LedgerService(createLedgerClient(ledgerConfig(env)), {
    pendingTimeoutSeconds: Number.isFinite(secs) && secs > 0 ? secs : 0,
  });
}

/** Effective rail limits: env overrides, else the defaults from money.ts. */
export function railLimitsFromEnv(env: AppEnv['Bindings']): RailLimits {
  const per = BigInt(env.RAIL_PER_TRANSFER_MINOR ?? DEFAULT_RAIL_LIMITS.perTransferMinor.toString());
  const daily = BigInt(env.RAIL_DAILY_MINOR ?? DEFAULT_RAIL_LIMITS.dailyMinor.toString());
  return { perTransferMinor: per, dailyMinor: daily };
}