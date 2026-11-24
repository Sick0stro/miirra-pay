import { neon } from '@neondatabase/serverless';
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';

import * as schema from './schema';

export type Db = NeonHttpDatabase<typeof schema>;

/**
 * Neon HTTP driver — fetch-based, works on Workers with no extra plumbing.
 *
 * CRITICAL: the HTTP driver does NOT persist DDL and DROPS `unsafe()` writes at
 * runtime (verified across the Miirra platform). So:
 *  - DDL is applied ONLY via scripts/migrate.mjs (websocket Pool driver).
 *  - Runtime writes use drizzle TAGGED TEMPLATES (`db.execute(sql\`...\`)`) —
 *    never `unsafe()`, or the write silently vanishes.
 */
let cached: { url: string; db: Db } | null = null;
export const getDb = (url: string): Db => {
  if (cached && cached.url === url) return cached.db;
  const db = drizzle(neon(url), { schema });
  cached = { url, db };
  return db;
};

export * as schema from './schema';