import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from 'drizzle-orm';

import { requireAuth, userOf } from '../auth';
import type { AppEnv } from '../env';
import { badRequest, notFound } from '../errors';
import { getDb } from '../db';
import { vendorVerifications } from '../db/schema';
import { diditFromEnv } from '../didit';
import { uuid } from '../ids';
import { parse } from '../validate';

/**
 * Verifications — Didit KYC/KYB session creation.
 *
 * POST /api/verifications/didit/session creates a Didit verification session
 * using the server-side DIDIT_API_KEY (never exposed to a client) and returns
 * the hosted URL + token for the client to redirect the user into. A matching
 * `vendor_verifications` row is created in `pending` state so the webhook can
 * later attach the decision.
 *
 * The API key, workflow id, and webhook secret are all server-side bindings —
 * the client app only ever receives the hosted URL and its own vendor/branch id.
 */

const SessionSchema = z.object({
  /** Which vendor/branch this verification onboards. */
  vendorId: z.string().min(1),
  branchId: z.string().optional(),
  importRecordId: z.string().optional(),
  /** Override the Didit workflow id (defaults to the configured one). */
  workflowId: z.string().uuid().optional(),
  /** Where Didit redirects the user after the flow. */
  callback: z.string().url().optional(),
});

export const verificationsRoute = new Hono<AppEnv>();

// ── POST /api/verifications/didit/session ────────────────────────────────────
verificationsRoute.post('/didit/session', requireAuth, async (c) => {
  const body = parse(SessionSchema, await c.req.json());
  const user = userOf(c);
  const db = getDb(c.env.DATABASE_URL);

  const workflowId = body.workflowId ?? (c.env as { DIDIT_WORKFLOW_ID?: string }).DIDIT_WORKFLOW_ID;
  if (!workflowId) {
    throw badRequest('No Didit workflow configured (set DIDIT_WORKFLOW_ID or pass workflowId)', 'no_workflow');
  }

  // vendor_data binds the Didit session to our entity. Use the platform user id
  // + vendor id so Didit's duplicate detection groups repeat verifications.
  const vendorData = `miirra:${user.id}:${body.vendorId}`;

  const didit = diditFromEnv(c.env as never);
  const session = await didit.createSession({
    workflowId,
    vendorData,
    callback: body.callback,
    metadata: { userId: user.id, vendorId: body.vendorId, branchId: body.branchId ?? null },
  });

  const now = Date.now();
  const id = uuid();
  await db.execute(sql`
    INSERT INTO miirra_pay.vendor_verifications
      (id, vendor_id, branch_id, import_record_id, didit_session_id, vendor_data, status, created_at, updated_at)
    VALUES (${id}, ${body.vendorId}, ${body.branchId ?? null}, ${body.importRecordId ?? null},
            ${session.session_id}, ${vendorData}, 'pending', ${now}, ${now})
    ON CONFLICT (didit_session_id) DO NOTHING
  `);

  // Return only what the client needs: the hosted URL + token to redirect into.
  // The API key never leaves the server.
  return c.json(
    {
      id,
      diditSessionId: session.session_id,
      url: session.url,
      sessionToken: session.session_token,
      status: 'pending',
    },
    201,
  );
});

// ── GET /api/verifications/:id ────────────────────────────────────────────────
verificationsRoute.get('/:id', requireAuth, async (c) => {
  const user = userOf(c);
  const db = getDb(c.env.DATABASE_URL);
  const id = c.req.param('id');
  const rows = await db.execute(sql`
    SELECT id, vendor_id, branch_id, didit_session_id, status, document_type,
           face_match_score, verified_at, created_at
    FROM miirra_pay.vendor_verifications WHERE id = ${id} LIMIT 1
  `);
  const r = rows.rows[0] as
    | { id: string; vendor_id: string; branch_id: string | null; didit_session_id: string; status: string;
        document_type: string | null; face_match_score: string | null; verified_at: number | null; created_at: number }
    | undefined;
  if (!r) throw notFound('Verification not found');
  return c.json({ ...r, _requestedBy: user.id });
});

// ── GET /api/verifications ────────────────────────────────────────────────────
verificationsRoute.get('', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const vendorId = c.req.query('vendorId');
  const rows = vendorId
    ? await db.execute(sql`
        SELECT id, vendor_id, branch_id, didit_session_id, status, document_type, face_match_score, verified_at, created_at
        FROM miirra_pay.vendor_verifications WHERE vendor_id = ${vendorId} ORDER BY created_at DESC LIMIT 50
      `)
    : await db.execute(sql`
        SELECT id, vendor_id, branch_id, didit_session_id, status, document_type, face_match_score, verified_at, created_at
        FROM miirra_pay.vendor_verifications ORDER BY created_at DESC LIMIT 50
      `);
  return c.json({ verifications: rows.rows });
});