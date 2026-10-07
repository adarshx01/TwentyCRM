import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

/**
 * Forward-only SQL migrations (migrations/NNNN_name.sql).
 * Applied in order inside one transaction each, guarded by an advisory lock so
 * concurrent deploys cannot interleave. Run with the OWNER role, not the runtime role.
 *
 *   DATABASE_URL=<owner url> node dist/database/migrate.js
 */
export async function runMigrations(databaseUrl: string, dir = join(__dirname, '..', '..', 'migrations')): Promise<string[]> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  const applied: string[] = [];
  try {
    await sql`select pg_advisory_lock(727274)`;
    await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    const done = new Set((await sql`select name from schema_migrations`).map((r) => r.name as string));
    const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const body = readFileSync(join(dir, file), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into schema_migrations (name) values (${file})`;
      });
      applied.push(file);
    }
  } finally {
    await sql`select pg_advisory_unlock(727274)`.catch(() => undefined);
    await sql.end({ timeout: 5 });
  }
  return applied;
}

if (require.main === module) {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL (or MIGRATION_DATABASE_URL) is required');
    process.exit(1);
  }
  runMigrations(url)
    .then((applied) => {
      console.log(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
