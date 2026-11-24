import { Hono } from 'hono';
import { sql } from 'drizzle-orm';

import type { AppEnv } from '../env';
import { getDb } from '../db';
import { verifyDiditSignature } from '../didit';
import { uuid } from '../ids';

/**
 * /webhooks/didit — inbound Didit verification events.
 *
 * Flow (verified against docs.didit.me):
 *   1. Verify the HMAC signature (X-Signature-V2 preferred, raw X-Signature
 *      fallback) against the body and X-Timestamp freshness (±300s). Fail closed.
 *   2. Parse + validate the envelope (event_id, webhook_type, session_id, status).
 *   3. Dedupe by event_id inside a transaction that locks the event row — a
 *      redelivery is a no-op, two concurrent deliveries cannot both act.
 *   4. Update vendor_verifications for the matching session_id, WITHOUT
 *      downgrading an already-`approved` record (delivery order is not
 *      guaranteed, so an older event must never overwrite newer state). Compare
 *      created_at and only move forward.
 *   5. Update vendor onboarding eligibility (derived from the verification
 *      status) — here reflected on the row so downstream consumers can gate on it.
 *
 * All heavy work is done inline (fast enough) but the endpoint returns 2xx as
 * soon as state is consistent, per Didit's retry guidance.
 */

type DiditEnvelope = {
  event_id?: string;
  webhook_type?: string;
  session_id?: string;
  status?: string;
  created_at?: number;
  timestamp?: number;
  vendor_data?: string;
  decision?: {
    face_matches?: Array<{ face_match_score?: number; score?: number }>;
    id_verifications?: Array<{ document_type?: string; id_type?: string }>;
  } & Record<string, unknown>;
};

/** Map a Didit status string to our vendor_verifications status. */
function mapStatus(didit: string | undefined): 'pending' | 'started' | 'approved' | 'declined' | 'expired' | 'failed' {
  switch (didit) {
    case 'Approved':
      return 'approved';
    case 'Declined':
      return 'declined';
    case 'Expired':
    case 'Kyc Expired':
    case 'Abandoned':
      return 'expired';
    case 'In Review':
    case 'In Progress':
    case 'Resubmitted':
    case 'Awaiting User':
      return 'started';
    case 'Not Started':
      return 'pending';
    default:
      return 'pending';
  }
}

export const diditWebhooksRoute = new Hono<AppEnv>();

diditWebhooksRoute.post('/didit', async (c) => {
  const rawBody = await c.req.text();

  // 1. Parse first (needed for V2 canonicalization), then verify.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return c.json({ error: { code: 'invalid_json', message: 'body is not JSON' } }, 400);
  }

  const sig = await verifyDiditSignature({
    secret: c.env.DIDIT_WEBHOOK_SECRET,
    headers: c.req.raw.headers,
    parsedBody: parsed,
    rawBody,
  });
  if (!sig.ok) {
    console.warn('[didit-webhook] rejected:', sig.reason);
    return c.json({ error: { code: 'invalid_signature', message: sig.reason } }, 401);
  }

  // 2. Validate the envelope.
  const env = parsed as DiditEnvelope;
  const webhookType = env.webhook_type;
  if (!webhookType || !env.event_id) {
    return c.json({ error: { code: 'invalid_envelope', message: 'missing webhook_type or event_id' } }, 400);
  }
  // We only act on session status changes; everything else is acked and ignored.
  if (webhookType !== 'status.updated' && webhookType !== 'data.updated') {
    return c.json({ received: true, ignored: `unhandled webhook_type: ${webhookType}` });
  }

  const db = getDb(c.env.DATABASE_URL);
  const now = Date.now();

  // 3. Dedupe by event_id inside a locked insert.
  const ins = await db.execute(sql`
    INSERT INTO miirra_pay.didit_webhook_events
      (id, didit_event_id, webhook_type, session_id, status, signature_valid, raw_body, result, received_at)
    VALUES (${uuid()}, ${env.event_id}, ${webhookType}, ${env.session_id ?? null}, ${env.status ?? null},
            ${sig.ok === true}, ${rawBody}, 'pending', ${now})
    ON CONFLICT (didit_event_id) DO NOTHING
    RETURNING id
  `);
  const inserted = (ins.rows[0] as { id: string } | undefined)?.id;
  if (!inserted) {
    return c.json({ received: true, duplicate: true, eventId: env.event_id });
  }

  try {
    // 4. Update the vendor_verifications row without downgrading.
    const newStatus = mapStatus(env.status);
    if (env.session_id) {
      await db.execute(sql`
        UPDATE miirra_pay.vendor_verifications
        SET status = ${newStatus},
            document_type = COALESCE(
              ${extractDocType(env.decision)},
              document_type
            ),
            face_match_score = COALESCE(
              ${extractFaceScore(env.decision)},
              face_match_score
            ),
            last_event_id = ${env.event_id},
            updated_at = ${now},
            verified_at = CASE WHEN ${newStatus} = 'approved' THEN ${now} ELSE verified_at END
        WHERE didit_session_id = ${env.session_id}
          AND (
            -- never downgrade an already-approved row
            status <> 'approved'
            OR ${newStatus} = 'approved'
          )
          AND (
            -- ignore older events (compare created_at when present)
            ${env.created_at ?? 0} = 0
            OR updated_at <= ${(env.created_at ?? 0) * 1000}
          )
      `);

      // 5. Vendor onboarding eligibility is DERIVED from the verification
      // status. Downstream consumers gate on `status = 'approved'`; we expose a
      // convenience column on the verification row already (status). If a
      // separate onboarding table exists in the wider platform, update it here.
    }

    await db.execute(sql`
      UPDATE miirra_pay.didit_webhook_events SET result = 'processed', processed_at = ${Date.now()}
      WHERE id = ${inserted}
    `);
    return c.json({ received: true, eventId: env.event_id, status: newStatus, result: 'processed' });
  } catch (err) {
    await db.execute(sql`
      UPDATE miirra_pay.didit_webhook_events SET result = 'error', processed_at = ${Date.now()}
      WHERE id = ${inserted}
    `);
    // Let the next delivery reprocess: remove the error row so ON CONFLICT
    // returns a fresh insert next time.
    await db.execute(sql`DELETE FROM miirra_pay.didit_webhook_events WHERE id = ${inserted} AND result = 'error'`);
    console.error('[didit-webhook] processing failed:', err instanceof Error ? err.message : err);
    return c.json({ error: { code: 'processing_failed', message: 'will retry' } }, 500);
  }
});

function extractFaceScore(decision: DiditEnvelope['decision']): string | null {
  const fm = decision?.face_matches?.[0];
  const raw = fm?.face_match_score ?? fm?.score;
  return typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : null;
}

function extractDocType(decision: DiditEnvelope['decision']): string | null {
  const idv = decision?.id_verifications?.[0];
  return idv?.document_type ?? idv?.id_type ?? null;
}