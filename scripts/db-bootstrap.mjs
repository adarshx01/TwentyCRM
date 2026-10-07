#!/usr/bin/env node
// Idempotent database bootstrap for a managed PostgreSQL (e.g. Supabase): creates the owner/runtime roles and a dedicated
// schema, so the runtime role is NOT a superuser and NOT the table owner (row-level security then really applies).
//   ADMIN_DATABASE_URL=<postgres admin, session mode> CRMBEE_OWNER_PASSWORD=… CRMBEE_APP_PASSWORD=… [DB_SCHEMA=crmbee] node scripts/db-bootstrap.mjs
import postgres from 'postgres';
const { ADMIN_DATABASE_URL, CRMBEE_OWNER_PASSWORD, CRMBEE_APP_PASSWORD } = process.env;
const schema = process.env.DB_SCHEMA ?? 'crmbee';
if (!ADMIN_DATABASE_URL || !CRMBEE_OWNER_PASSWORD || !CRMBEE_APP_PASSWORD) { console.error('ADMIN_DATABASE_URL, CRMBEE_OWNER_PASSWORD and CRMBEE_APP_PASSWORD are required'); process.exit(1); }
if (!/^[a-z_][a-z0-9_]{0,40}$/.test(schema)) { console.error('invalid DB_SCHEMA'); process.exit(1); }
const sql = postgres(ADMIN_DATABASE_URL, { max: 1, prepare: false, onnotice: () => undefined });
const lit = (v) => `'${v.replace(/'/g, "''")}'`;
try {
  for (const [role, pw] of [['crmbee_owner', CRMBEE_OWNER_PASSWORD], ['crmbee_app', CRMBEE_APP_PASSWORD]]) {
    const [r] = await sql`select 1 as x from pg_roles where rolname = ${role}`;
    await sql.unsafe(r ? `alter role ${role} login password ${lit(pw)} nosuperuser nocreatedb nocreaterole` : `create role ${role} login password ${lit(pw)} nosuperuser nocreatedb nocreaterole`);
  }
  // Supabase: let the admin role administer members so it can create the schema for the owner.
  await sql.unsafe('grant crmbee_owner to current_user').catch(() => undefined);
  await sql.unsafe(`create schema if not exists ${schema} authorization crmbee_owner`);
  await sql.unsafe(`alter role crmbee_owner set search_path = ${schema}`);
  await sql.unsafe(`alter role crmbee_app set search_path = ${schema}`);
  await sql.unsafe(`grant usage on schema ${schema} to crmbee_app`);
  // Keep Supabase's public Data API away from our tables.
  await sql.unsafe(`revoke all on schema ${schema} from anon, authenticated`).catch(() => undefined);
  console.log(`roles crmbee_owner / crmbee_app and schema "${schema}" are ready`);
} finally { await sql.end({ timeout: 5 }); }
