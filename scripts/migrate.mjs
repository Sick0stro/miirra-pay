// Apply generated SQL migrations using the WEBSOCKET Pool driver.
// The Neon HTTP driver does NOT persist DDL (verified across the Miirra
// platform); the ws Pool does. Re-run-safe: re-applies every file each run and
// rewrites CREATE/ADD COLUMN to IF NOT EXISTS so a column already applied can
// never abort the batch.
//
// Usage: node scripts/migrate.mjs
// Reads DATABASE_URL from .dev.vars (what wrangler dev uses).
import { Pool } from '@neondatabase/serverless';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const devVars = readFileSync('.dev.vars', 'utf8');
const m = devVars.match(/^DATABASE_URL="?(.+?)"?$/m);
if (!m) throw new Error('DATABASE_URL missing from .dev.vars');
const url = m[1];

const pool = new Pool({ connectionString: url });

try {
  // Ensure the dedicated schema exists before any table does.
  await pool.query(`CREATE SCHEMA IF NOT EXISTS miirra_pay`);

  const dir = 'drizzle';
  if (!existsSync(dir)) {
    console.error('no drizzle/ dir — run `npm run db:generate` first');
    process.exit(1);
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    console.error('no .sql migrations found — run `npm run db:generate`');
    process.exit(1);
  }

  for (const file of files) {
    const ddl = readFileSync(join(dir, file), 'utf8');
    const statements = ddl
      .split(/-->\s*statement-breakpoint/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !/^--/.test(s));
    console.log(`applying ${file} (${statements.length} statements)`);
    for (const stmt of statements) {
      let sql = stmt;
      sql = sql.replace(/^CREATE SCHEMA\s+/i, 'CREATE SCHEMA IF NOT EXISTS ');
      sql = sql.replace(/^CREATE TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS ');
      sql = sql.replace(/(ADD COLUMN\s+)(?!IF NOT EXISTS)/i, '$1IF NOT EXISTS ');
      sql = sql.replace(/(CREATE (?:UNIQUE )?INDEX\s+)(?!IF NOT EXISTS)/i, '$1IF NOT EXISTS ');
      await pool.query(sql);
    }
    console.log('  ok');
  }

  const res = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'miirra_pay' ORDER BY tablename`,
  );
  console.log('tables in miirra_pay:', res.rows.map((r) => r.tablename).join(', '));
  console.log('DONE —', res.rows.length, 'tables');
} finally {
  await pool.end();
}