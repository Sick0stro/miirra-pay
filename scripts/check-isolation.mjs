import { Pool } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
const url = readFileSync('.dev.vars', 'utf8').match(/^DATABASE_URL="?(.+?)"?$/m)[1];
const p = new Pool({ connectionString: url });
const a = await p.query("SELECT count(*) c FROM pg_tables WHERE schemaname='miirra_api'");
const b = await p.query("SELECT count(*) c FROM pg_tables WHERE schemaname='miirra_pay'");
console.log('miirra_api tables:', a.rows[0].c);
console.log('miirra_pay tables:', b.rows[0].c);
await p.end();