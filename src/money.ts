/**
 * LYD money configuration — the SINGLE source of truth for minor-unit scaling,
 * rail caps, and step-up verification thresholds.
 *
 * WHY ONE MODULE
 * --------------
 * LYD has `MINOR_UNITS_PER_MAJOR = 100` (2 decimal places, piastres). Every
 * amount that crosses the system is an integer count of minor units. If the
 * scale factor, a rail cap, or the "needs face verification" threshold were
 * each written as a literal in different files, a single edit would silently
 * desync amount validation from the ledger from the KYC gate — exactly the
 * class of bug that moves money incorrectly. So they live here, named once, and
 * are imported everywhere.
 *
 * The LYPay rail also speaks minor-unit DECIMAL STRINGS ("2000760" = 2000.760
 * LYD) — see `lydToRailString` / `railStringToMinor`.
 */

/** Piastres per LYD. LYD is quoted to 2 dp like most currencies. */
export const MINOR_UNITS_PER_MAJOR = 100;

/** TigerBeetle ledger id for LYD (ledger 1). */
export const LYD_LEDGER = 1;

/** The rail currency token LYPay expects. */
export const LYD_CURRENCY = 'lyd';

/**
 * Step-up verification threshold. Transfers ABOVE this many minor units require
 * a fresh Didit face-verification match. 1,000 LYD = 100_000 minor units.
 *
 * This is a compliance control (CBL KYC/AML for higher-value person-to-person
 * movement), so it is a named constant, not a literal at the call site.
 */
export const FACE_VERIFY_THRESHOLD_MINOR = 1000 * MINOR_UNITS_PER_MAJOR; // 100000

/** Configurable rail + daily caps (minor units). Overridable via env. */
export type RailLimits = {
  /** Max single transfer, minor units. */
  perTransferMinor: bigint;
  /** Max cumulative outflow per user per rolling 24h, minor units. */
  dailyMinor: bigint;
};

/** Sensible defaults; a deployment overrides these from env/secrets. */
export const DEFAULT_RAIL_LIMITS: RailLimits = {
  perTransferMinor: 500_000n, // 5,000 LYD
  dailyMinor: 2_000_000n, // 20,000 LYD / 24h
};

/** True when an amount (minor units) is at or below the per-transfer cap. */
export const withinPerTransferCap = (amountMinor: bigint | number, limits: RailLimits): boolean =>
  BigInt(amountMinor) <= limits.perTransferMinor;

/** True when an amount (minor units) STRICTLY EXCEEDS the face-verify threshold. */
export const needsFaceVerification = (amountMinor: bigint | number): boolean =>
  BigInt(amountMinor) > BigInt(FACE_VERIFY_THRESHOLD_MINOR);

// ── conversions ──────────────────────────────────────────────────────────────

/** Format minor units as the LYPay rail decimal string ("2000760"). */
export const lydToRailString = (minor: bigint | number): string => BigInt(minor).toString(10);

/** Parse a LYPay rail decimal string back to minor units (bigint). */
export const railStringToMinor = (rail: string): bigint => {
  // Rail amounts are integer minor units as strings; reject anything fractional
  // or non-numeric rather than silently truncating money.
  if (!/^\d+$/.test(rail)) throw new Error(`invalid rail amount: ${rail}`);
  return BigInt(rail);
};

/** Major-unit LYD (number) → minor units (bigint). e.g. 20.5 → 2050n. */
export const majorToMinor = (major: number): bigint =>
  BigInt(Math.round(major * MINOR_UNITS_PER_MAJOR));

/** Minor units (bigint) → major LYD (number) for display. */
export const minorToMajor = (minor: bigint | number): number =>
  Number(minor) / MINOR_UNITS_PER_MAJOR;

/** Human string for logs/receipts: 250000n → "2,500.00 LYD". */
export const formatLyd = (minor: bigint | number): string =>
  `${minorToMajor(minor).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} LYD`;