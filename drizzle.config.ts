import { defineConfig } from 'drizzle-kit';

// Same pattern as miirra-api: generate SQL migrations with drizzle-kit, then
// apply them ONLY through scripts/migrate.mjs (the websocket Pool driver).
// The Neon HTTP driver does not persist DDL — never apply DDL at runtime.
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});