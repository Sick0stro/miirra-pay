/**
 * Tamper-evident, hash-chained audit log (CBL Art. 27).
 *
 * Every security-relevant action appends a row whose `hash` covers the previous
 * row's hash plus this row's canonical fields:
 *
 *   hash_n = SHA-256( prev_hash_{n-1} || seq || actor || action ||
 *                      entity || entity_id || amount_minor || currency || at )
 *
 * Because each hash depends on its predecessor, altering or deleting any row
 * invalidates every subsequent hash — `verifyAuditChain` detects it. Appends
 * are serialized under a Postgres advisory lock so concurrent writers cannot
 * fork the chain.
 *
 * WebCrypto only — Workers has no `node:crypto`. SHA-256 is async.
 */

import { sql } from 'drizzle-orm';
import type { Db } from './db';
import { uuid } from './ids';

const GENESIS_HASH = '0'.repeat(64);
const enc = new TextEncoder();

async function sha256Hex(msg: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(msg));
  const b = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i]!.toString(16).padStart(2, '0');
  return out;
}

/** The canonical string that gets hashed for a row. */
function canonical(row: {
  seq: number;
  actor: string;
  action: string;
  entity: string | null;
  entityId: string | null;
  amountMinor: number;
  currency: string;
  at: number;
}): string {
  return [
    row.seq,
    row.actor,
    row.action,
    row.entity ?? '',
    row.entityId ?? '',
    row.amountMinor,
    row.currency,
    row.at,
  ].join('|');
}

export type AuditEntry = {
  actor: string;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  amountMinor?: number;
  currency?: string;
  detail?: string | null;
  at?: number;
};

/**
 * Append an entry to the hash-chained audit log. Serialized by a Postgres
 * advisory lock so the chain never forks under concurrency.
 */
export async function appendAudit(db: Db, entry: AuditEntry): Promise<{ seq: number; hash: string }> {
  const at = entry.at ?? Date.now();
  const currency = entry.currency ?? 'LYD';
  const amountMinor = entry.amountMinor ?? 0;
  const entity = entry.entity ?? null;
  const entityId = entry.entityId ?? null;

  // Serialize chain appends across concurrent requests.
  await db.execute(sql`SELECT pg_advisory_xact_lock(424242)`);

  const last = await db.execute(sql`
    SELECT seq, hash FROM miirra_pay.audit_log ORDER BY seq DESC LIMIT 1
  `);
  const prev = last.rows[0] as { seq: number | string; hash: string } | undefined;
  const seq = prev ? Number(prev.seq) + 1 : 1;
  const prevHash = prev?.hash ?? GENESIS_HASH;

  const hash = await sha256Hex(
    `${prevHash}|${canonical({ seq, actor: entry.actor, action: entry.action, entity, entityId, amountMinor, currency, at })}`,
  );

  await db.execute(sql`
    INSERT INTO miirra_pay.audit_log
      (id, seq, actor, action, entity, entity_id, amount_minor, currency, detail, hash, prev_hash, at)
    VALUES (${uuid()}, ${seq}, ${entry.actor}, ${entry.action}, ${entity}, ${entityId},
            ${amountMinor}, ${currency}, ${entry.detail ?? null}, ${hash}, ${prevHash}, ${at})
  `);

  return { seq, hash };
}

export type AuditVerification = {
  ok: boolean;
  count: number;
  /** First seq where the chain breaks, if any. */
  brokenAtSeq: number | null;
  detail: string;
};

/**
 * Verify the whole audit chain: recompute each hash and confirm it matches the
 * stored hash and the previous row's hash. O(n) SHA-256 over the chain.
 */
export async function verifyAuditChain(db: Db): Promise<AuditVerification> {
  const res = await db.execute(sql`
    SELECT seq, actor, action, entity, entity_id, amount_minor, currency, hash, prev_hash, at
    FROM miirra_pay.audit_log ORDER BY seq ASC
  `);
  const rows = res.rows as Array<{
    seq: number | string;
    actor: string;
    action: string;
    entity: string | null;
    entity_id: string | null;
    amount_minor: number | string;
    currency: string;
    hash: string;
    prev_hash: string;
    at: number | string;
  }>;

  let prevHash = GENESIS_HASH;
  for (const r of rows) {
    const seq = Number(r.seq);
    if (r.prev_hash !== prevHash) {
      return { ok: false, count: rows.length, brokenAtSeq: seq, detail: `prev_hash mismatch at seq ${seq}` };
    }
    const expected = await sha256Hex(
      `${prevHash}|${canonical({
        seq,
        actor: r.actor,
        action: r.action,
        entity: r.entity,
        entityId: r.entity_id,
        amountMinor: Number(r.amount_minor),
        currency: r.currency,
        at: Number(r.at),
      })}`,
    );
    if (expected !== r.hash) {
      return { ok: false, count: rows.length, brokenAtSeq: seq, detail: `hash mismatch at seq ${seq}` };
    }
    prevHash = r.hash;
  }
  return { ok: true, count: rows.length, brokenAtSeq: null, detail: `chain intact (${rows.length} rows)` };
}