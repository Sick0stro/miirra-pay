/**
 * Webhook HMAC verification for LYPay inbound events.
 *
 * WebCrypto only — Workers has no `node:crypto`. The scheme mirrors the
 * provider's documented model: LYPay (or the participating institution's edge)
 * signs the raw body with a shared secret, and we verify before doing anything
 * else. A forged or replayed body never reaches the state machine.
 *
 * We support two common header conventions because the exact header name is an
 * integration detail set when the endpoint is registered with LYPay:
 *   - X-LYPay-Signature: hex(hmac_sha256(secret, rawBody))
 *   - Authorization: "HMAC <hex>"  (same digest)
 *
 * Verification is constant-time and fails CLOSED — if the secret is unset, or
 * the header is missing, the request is rejected. An unset secret must never
 * mean "accept everything".
 */

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i]!.toString(16).padStart(2, '0');
  return out;
}

/** Import the shared secret as an HMAC-SHA256 key. */
async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/** Compute hex(hmac_sha256(secret, body)). */
export async function signBody(secret: string, body: string): Promise<string> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return hex(sig);
}

/** Constant-time string comparison (avoids timing leaks on the digest). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type SignatureResult =
  | { ok: true; scheme: string }
  | { ok: false; reason: string };

/**
 * Verify an inbound webhook's HMAC against the raw body. Returns a discriminated
 * result rather than throwing so a route can answer 401 cleanly.
 *
 * `headers` is the request's Headers object. `rawBody` is the EXACT body bytes
 * as received (verify against the raw string, never a re-serialized parse).
 */
export async function verifyWebhookSignature(params: {
  secret: string | undefined;
  headers: Headers;
  rawBody: string;
}): Promise<SignatureResult> {
  const { secret, headers, rawBody } = params;
  if (!secret) return { ok: false, reason: 'webhook secret not configured' };

  const sigHeader = headers.get('X-LYPay-Signature');
  const authHeader = headers.get('Authorization');
  const provided = sigHeader ?? (authHeader?.startsWith('HMAC ') ? authHeader.slice(5).trim() : null);
  if (!provided) return { ok: false, reason: 'missing signature header' };

  const expected = await signBody(secret, rawBody);
  if (!timingSafeEqual(expected.toLowerCase(), provided.toLowerCase())) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true, scheme: sigHeader ? 'X-LYPay-Signature' : 'Authorization: HMAC' };
}