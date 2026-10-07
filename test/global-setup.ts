import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { runMigrations } from '../src/database/migrate';

/**
 * Starts a throw-away PostgreSQL cluster for the whole test run (no Docker needed) and
 * builds a migrated template database. Each test file clones it, so tests are isolated
 * and fast. The runtime role `crmbee_app` is NOT a superuser, so row-level security is
 * genuinely enforced in every test.
 */
function findBin(): string {
  if (process.env.PG_BIN && existsSync(process.env.PG_BIN)) return process.env.PG_BIN;
  const root = '/usr/lib/postgresql';
  const versions = existsSync(root) ? readdirSync(root).filter((v) => existsSync(join(root, v, 'bin', 'initdb'))).sort((a, b) => Number(b) - Number(a)) : [];
  const preferred = versions.find((v) => v === '16') ?? versions[0];
  if (!preferred) throw new Error('PostgreSQL binaries not found. Set PG_BIN to a directory containing initdb/pg_ctl.');
  return join(root, preferred, 'bin');
}

const freePort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, () => { const p = (s.address() as any).port; s.close(() => resolve(p)); }); });

export default async function setup() {
  if (process.env.TEST_PG_ADMIN_URL) return; // use an externally provided server (CI service container)
  const bin = findBin();
  const dir = mkdtempSync(join(tmpdir(), 'crmbee-pg-'));
  const port = await freePort();
  execFileSync(join(bin, 'initdb'), ['-D', join(dir, 'data'), '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-sync'], { stdio: 'ignore' });
  const r = spawnSync(join(bin, 'pg_ctl'), ['-D', join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=400`, '-w', '-l', join(dir, 'pg.log'), 'start'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`pg_ctl failed: ${r.stderr}\n${r.stdout}`);

  const admin = `postgresql://postgres@127.0.0.1:${port}/postgres`;
  const sql = postgres(admin, { max: 1, onnotice: () => undefined });
  await sql.unsafe(`create role crmbee_app login password 'crmbee_app' nosuperuser nocreatedb nocreaterole`);
  await sql.unsafe('create database crmbee_template');
  await sql.end();
  await runMigrations(`postgresql://postgres@127.0.0.1:${port}/crmbee_template`);
  process.env.TEST_PG_ADMIN_URL = admin;
  process.env.TEST_PG_PORT = String(port);

  return async () => {
    spawnSync(join(bin, 'pg_ctl'), ['-D', join(dir, 'data'), '-m', 'immediate', 'stop'], { stdio: 'ignore' });
    rmSync(dir, { recursive: true, force: true });
  };
}
