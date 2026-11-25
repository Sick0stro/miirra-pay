/**
 * Clerk session-token verification (server-side).
 *
 * The SPA signs the user in with Clerk (phone OTP) and sends the short-lived
 * Clerk session JWT as `Authorization: Bearer <token>`. We verify it here
 * against Clerk's JWKS — no network hop to Clerk per request, no shared secret
 * in the browser.
 *
 * A verified token yields the Clerk user id (`sub`), which becomes the platform
 * user id for the rest of Miirra Pay. Better Auth tokens still work through the
 * existing DB path in auth.ts; this module only handles Clerk JWTs.
 */

import type { AuthUser } from './auth';

export type ClerkConfig = {
  /** JWKS URL, e.g. https://<clerk-domain>/.well-known/jwks.json */
  jwksUrl: string;
  /** Expected issuer (Clerk FRONTEND_API / instance domain), if set. */
  issuer?: string;
  /** Expected audience, if the token is audience-scoped. */
  audience?: string;
};

export function clerkConfigFromEnv(env: {
  CLERK_JWKS_URL?: string;
  CLERK_ISSUER?: string;
  CLERK_AUDIENCE?: string;
}): ClerkConfig | null {
  const jwksUrl = env.CLERK_JWKS_URL;
  if (!jwksUrl) return null;
  return { jwksUrl, issuer: env.CLERK_ISSUER, audience: env.CLERK_AUDIENCE };
}

/** A JWT has three base64url segments. Cheap shape check before doing work. */
export function looksLikeJwt(token: string): boolean {
  return token.split('.').length === 3;
}

function b64urlDecode(seg: string): Uint8Array {
  const pad = seg.length % 4 === 0 ? '' : '='.repeat(4 - (seg.length % 4));
  const b64 = (seg + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlJson(seg: string): any {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(seg)));
}

// Cache the JWKS per url for a short while (Clerk rotates keys rarely).
let jwksCache: { url: string; exp: number; keys: any[] } | null = null;
const JWKS_TTL_MS = 5 * 60_000;

async function loadJwks(url: string): Promise<any[]> {
  const now = Date.now();
  if (jwksCache && jwksCache.url === url && jwksCache.exp > now) return jwksCache.keys;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`jwks fetch ${res.status}`);
  const j = (await res.json()) as { keys: any[] };
  jwksCache = { url, exp: now + JWKS_TTL_MS, keys: j.keys || [] };
  return jwksCache.keys;
}

export async function verifyClerkToken(token: string, cfg: ClerkConfig): Promise<AuthUser | null> {
  let header: any, payload: any;
  try {
    [header, payload] = [b64urlJson(token.split('.')[0]!), b64urlJson(token.split('.')[1]!)];
  } catch {
    return null;
  }

  // Validate claims.
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp <= now) return null;
  if (cfg.issuer && payload.iss !== cfg.issuer) return null;
  if (cfg.audience) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(cfg.audience)) return null;
  }
  const sub = payload.sub;
  if (!sub || typeof sub !== 'string') return null;

  // Verify signature against the matching JWK.
  const keys = await loadJwks(cfg.jwksUrl);
  const jwk = keys.find((k) => k.kid === header.kid) || keys[0];
  if (!jwk) return null;

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RS256', hash: 'SHA-256' }, false, ['verify']);
  const [h, p, s] = token.split('.');
  const sig = b64urlDecode(s!);
  const okSig = await crypto.subtle.verify('RS256', key, sig, new TextEncoder().encode(`${h}.${p}`));
  if (!okSig) return null;

  const email = payload.email || payload.email_address || null;
  const name = payload.name || payload.full_name || (payload.first_name ? `${payload.first_name} ${payload.last_name || ''}`.trim() : null);
  return { id: sub, email: email ?? null, name: name ?? null, authRole: 'user' };
}