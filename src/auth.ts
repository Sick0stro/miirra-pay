import type { Context, Next } from 'hono';
import { sql } from 'drizzle-orm';

import { getDb } from './db';
import { unauthorized } from './errors';
import { clerkConfigFromEnv, looksLikeJwt, verifyClerkToken } from './clerk-auth';

/**
 * Session verification — identical model to miirra-api.
 *
 * Identity (miirra-web, Better Auth) owns sessions and runs against the SAME
 * Neon database this worker uses, so a bearer token is verified by reading
 * Better Auth's `session` table directly (raw SQL — that schema is identity's,
 * not ours; declaring it in our drizzle schema would imply we may write it).
 * The row is the authoritative session state, so this needs no HTTP hop to
 * identity and no origin coupling — identity can be deployed independently.
 *
 * Responses are cached 60s per token in this isolate.
 */

export type AuthUser = {
  id: string;
  email: string | null;
  name: string | null;
  authRole: string | null;
};

const cache = new Map<string, { user: AuthUser; exp: number }>();
const CACHE_TTL_MS = 60_000;

export const verifySession = async (c: Context, token: string): Promise<AuthUser | null> => {
  const now = Date.now();
  const hit = cache.get(token);
  if (hit && hit.exp > now) return hit.user;

  try {
    const db = getDb(c.env.DATABASE_URL as string);
    const res = await db.execute(sql`
      SELECT u.id, u.email, u.name, u.role
      FROM public.session s
      JOIN public."user" u ON u.id = s.user_id
      WHERE s.token = ${token} AND s.expires_at > now()
    `);
    const row = res.rows[0] as
      | { id: string; email: string | null; name: string | null; role: string | null }
      | undefined;
    if (!row?.id) return null;
    const user: AuthUser = {
      id: row.id,
      email: row.email,
      name: row.name,
      authRole: row.role ?? null,
    };
    cache.set(token, { user, exp: now + CACHE_TTL_MS });
    return user;
  } catch (err) {
    // Do not swallow: a DB failure and an invalid token both surface as 401,
    // which is undiagnosable from the client. Log the distinction.
    console.error('[auth] verifySession failed:', err instanceof Error ? err.message : err);
    return null;
  }
};

/** Read the bearer token from the Authorization header. */
export const bearerToken = (c: Context): string | null => {
  const header = c.req.header('Authorization') ?? '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
};

/**
 * Resolve the caller's identity onto `c.auth`. In dev (AUTH_DEV_MODE=1) the
 * `x-dev-user` header impersonates a user — this is what makes the E2E suite
 * runnable with no real identity server. Production must NEVER set that var.
 */
export const resolveAuth = async (c: Context): Promise<AuthUser> => {
  const existing = c.get('auth') as AuthUser | undefined;
  if (existing) return existing;

  const devMode = (c.env.AUTH_DEV_MODE as string | undefined) === '1';
  if (devMode) {
    const devUser = c.req.header('x-dev-user');
    if (devUser) {
      const user: AuthUser = {
        id: devUser,
        email: `${devUser}@dev.local`,
        name: devUser,
        authRole: 'user',
      };
      c.set('auth', user);
      return user;
    }
  }

  const token = bearerToken(c);
  if (!token) throw unauthorized('Missing bearer token');

  // Clerk session JWT (phone OTP sign-in) — verify against Clerk's JWKS.
  const cfg = clerkConfigFromEnv(c.env as never);
  if (cfg && looksLikeJwt(token)) {
    const clerkUser = await verifyClerkToken(token, cfg).catch(() => null);
    if (clerkUser) {
      cache.set(token, { user: clerkUser, exp: Date.now() + CACHE_TTL_MS });
      c.set('auth', clerkUser);
      return clerkUser;
    }
  }

  // Better Auth session (identity server) — the original path.
  const user = await verifySession(c, token);
  if (!user) throw unauthorized('Invalid or expired session');
  c.set('auth', user);
  return user;
};

export const requireAuth = async (c: Context, next: Next) => {
  await resolveAuth(c);
  await next();
};

/** The resolved AuthUser, for handlers mounted behind requireAuth(). */
export const userOf = (c: Context): AuthUser => {
  const u = c.get('auth') as AuthUser | undefined;
  if (!u) throw new Error('auth context missing — handler must sit behind requireAuth()');
  return u;
};