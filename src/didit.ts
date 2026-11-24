/**
 * Didit verification client + webhook signature verification.
 *
 * Verified against https://docs.didit.me on 2026-11-24:
 *  - Create session: POST https://verification.didit.me/v3/session/ with header
 *    `x-api-key`, body { workflow_id, vendor_data, callback?, metadata? }.
 *    Returns 201 { session_id, session_token, url, status, ... }.
 *  - Webhooks: HMAC-SHA256. Preferred `X-Signature-V2` = hex(hmac(secret,
 *    canonicalJSON)) where canonicalJSON = JSON.stringify with recursively
 *    SORTED keys and whole-valued floats shortened to ints. `X-Timestamp` is
 *    unix seconds; reject if abs(now - ts) > 300s. Event carries `event_id`
 *    (idempotency key), `session_id`, `status`, `webhook_type`, `decision`.
 *
 * WebCrypto only — Workers has no `node:crypto`.
 */

import { UpstreamError, upstream } from './errors';

export type DiditConfig = {
  apiKey: string;
  baseUrl?: string;
  webhookSecret?: string;
  timeoutMs?: number;
};

const enc = new TextEncoder();

// ── session creation ──────────────────────────────────────────────────────────

export type CreateSessionResult = {
  session_id: string;
  session_token: string;
  url: string;
  status: string;
};

export class DiditClient {
  constructor(private cfg: DiditConfig) {}

  private base(): string {
    return (this.cfg.baseUrl ?? 'https://verification.didit.me').replace(/\/$/, '');
  }

  /** Create a KYC/KYB verification session. Returns the hosted URL + token. */
  async createSession(params: {
    workflowId: string;
    vendorData: string;
    callback?: string;
    metadata?: Record<string, unknown>;
  }): Promise<CreateSessionResult> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 8000);
    let res: Response;
    try {
      res = await fetch(`${this.base()}/v3/session/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.cfg.apiKey },
        body: JSON.stringify({
          workflow_id: params.workflowId,
          vendor_data: params.vendorData,
          ...(params.callback ? { callback: params.callback } : {}),
          ...(params.metadata ? { metadata: params.metadata } : {}),
        }),
        signal: ctrl.signal,
      });
    } catch (err) {
      throw upstream(`Didit session request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(t);
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 401) throw new UpstreamError(502, 'didit_unauthorized', 'Didit rejected the API key');
    if (res.status === 403) throw new UpstreamError(502, 'didit_forbidden', 'Didit key lacks write:sessions');
    if (res.status === 429) throw new UpstreamError(502, 'didit_rate_limited', 'Didit rate limit hit', 429, body);
    if (res.status < 200 || res.status >= 300) {
      const detail = (body.detail as string) ?? (body.workflow_id as string) ?? `Didit returned ${res.status}`;
      throw upstream(`Didit session error: ${detail}`, res.status, body);
    }
    const url = body.url as string;
    const session_id = body.session_id as string;
    if (!url || !session_id) throw upstream('Didit response missing url/session_id', res.status, body);
    return {
      session_id,
      session_token: (body.session_token as string) ?? '',
      url,
      status: (body.status as string) ?? 'Not Started',
    };
  }
}

export function diditFromEnv(env: {
  DIDIT_API_KEY?: string;
  DIDIT_BASE_URL?: string;
  DIDIT_WEBHOOK_SECRET?: string;
}): DiditClient {
  return new DiditClient({
    apiKey: env.DIDIT_API_KEY ?? '',
    baseUrl: env.DIDIT_BASE_URL,
    webhookSecret: env.DIDIT_WEBHOOK_SECRET,
  });
}

// ── webhook signature verification ─────────────────────────────────────────────

/** Recursively sort object keys — reproduces Didit's canonical JSON. */
function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = sortKeysDeep(o[k]);
    return out;
  }
  return v;
}

/** Didit serializes whole-valued floats as ints; normalize before hashing V2. */
function shortenFloats(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(shortenFloats);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) out[k] = shortenFloats(val);
    return out;
  }
  if (typeof v === 'number' && !Number.isInteger(v) && v % 1 === 0) return Math.trunc(v);
  return v;
}

function hex(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i]!.toString(16).padStart(2, '0');
  return out;
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return hex(sig);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type DiditSignatureResult = { ok: true; scheme: string } | { ok: false; reason: string };

/**
 * Verify a Didit webhook. Prefers X-Signature-V2 (canonical sorted JSON, covers
 * the whole body including `decision`), falls back to raw-bytes X-Signature.
 * Rejects stale timestamps (> 300s) to block replays. Fails CLOSED.
 */
export async function verifyDiditSignature(params: {
  secret: string | undefined;
  headers: Headers;
  parsedBody: unknown;
  rawBody: string;
}): Promise<DiditSignatureResult> {
  const { secret, headers, parsedBody, rawBody } = params;
  if (!secret) return { ok: false, reason: 'didit webhook secret not configured' };

  const tsHeader = headers.get('X-Timestamp');
  if (!tsHeader) return { ok: false, reason: 'missing X-Timestamp' };
  const ts = Number(tsHeader);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'invalid X-Timestamp' };
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > 300) return { ok: false, reason: 'stale timestamp (replay guard)' };

  const v2 = headers.get('X-Signature-V2');
  const v2Prev = headers.get('X-Signature-V2-Previous');
  const raw = headers.get('X-Signature');
  const rawPrev = headers.get('X-Signature-Previous');

  // 1) X-Signature-V2: canonical JSON = sort keys + shorten whole floats.
  if (v2 || v2Prev) {
    const canonical = JSON.stringify(sortKeysDeep(shortenFloats(parsedBody)));
    const expected = await hmacHex(secret, canonical);
    if ((v2 && timingSafeEqual(expected, v2)) || (v2Prev && timingSafeEqual(expected, v2Prev))) {
      return { ok: true, scheme: 'X-Signature-V2' };
    }
    // fall through to raw-bytes if V2 present but didn't match
  }

  // 2) X-Signature: exact raw bytes.
  if (raw || rawPrev) {
    const expected = await hmacHex(secret, rawBody);
    if ((raw && timingSafeEqual(expected, raw)) || (rawPrev && timingSafeEqual(expected, rawPrev))) {
      return { ok: true, scheme: 'X-Signature' };
    }
  }

  return { ok: false, reason: 'signature mismatch' };
}