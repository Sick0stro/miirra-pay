/** Web Crypto helpers — Workers has no `node:crypto`. */
export const uuid = (): string => crypto.randomUUID();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when a value looks like a uuid — guards uuid columns from 500s. */
export const isUuid = (v: string): boolean => UUID_RE.test(v);

/** Secure random integer in [min, max). */
export const randomInt = (min: number, max: number): number => {
  const range = max - min;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return min + (buf[0]! % range);
};

/** A cryptographically random alphanumeric string of length `n` (A-Z, 0-9). */
export const randomAlnum = (n: number): string => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const buf = new Uint32Array(n);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[buf[i]! % alphabet.length];
  return out;
};

/**
 * The LYPay `internalMerchantReference` — MANDATORY for P2M, format:
 *
 *   [INST_CODE: 3 digits][TIMESTAMP: 10 digits][INSTITUTION_REFERENCE: 8 alnum]
 *
 * e.g. `0021625097600A1B2C3D4`. This is what LYPay uses to correlate a
 * person-to-merchant payment back to a merchant's POS/QR checkout, and it is
 * the string a merchant's system quotes when querying "by internal merchant
 * reference" (GET .../by-internal-merchant-reference).
 */
export const internalMerchantReference = (institutionCode: string): string => {
  const inst = institutionCode.padStart(3, '0').slice(-3);
  const ts = String(Math.floor(Date.now() / 1000)).padStart(10, '0').slice(-10);
  const ref = randomAlnum(8);
  return `${inst}${ts}${ref}`;
};

/** A high-entropy deposit reference for a top-up intent (human-quotable). */
export const depositReference = (): string => {
  // Two groups of 6 unambiguous chars — easy to read over the phone / type
  // into a bank transfer reference field, still ~2^47 of entropy.
  const g = () => randomAlnum(6);
  return `${g()}-${g()}`;
};

/** Parse a LYPay internalMerchantReference into its parts, or null if malformed. */
export const parseInternalMerchantReference = (
  ref: string,
): { instCode: string; timestamp: number; instRef: string } | null => {
  if (!/^\d{3}\d{10}[A-Z0-9]{8}$/.test(ref)) return null;
  return {
    instCode: ref.slice(0, 3),
    timestamp: Number(ref.slice(3, 13)),
    instRef: ref.slice(13, 21),
  };
};