import { defineConfig } from 'drizzle-kit';

// `pnpm migrate:generate` writes SQL here; the reviewed output is committed as
// migrations/NNNN_*.sql and applied by src/database/migrate.ts.
export default defineConfig({
  schema: './src/database/schema.ts',
  out: './migrations/generated',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgresql://localhost/crmbee' },
  strict: true,
});
