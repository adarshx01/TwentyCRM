import { randomBytes } from 'node:crypto';
import postgres from 'postgres';

export interface TestDb {
  name: string;
  /** Runtime role (non-superuser): RLS applies */
  appUrl: string;
  /** Superuser URL for assertions/setup */
  ownerUrl: string;
  drop(): Promise<void>;
}

const withDb = (url: string, db: string) => url.replace(/\/[^/]*$/, `/${db}`);

/** Clone the migrated template into a fresh database for one test file. */
export async function createTestDb(): Promise<TestDb> {
  const admin = process.env.TEST_PG_ADMIN_URL!;
  const name = `t_${randomBytes(6).toString('hex')}`;
  const sql = postgres(admin, { max: 1, onnotice: () => undefined });
  await sql.unsafe(`create database ${name} template crmbee_template`);
  await sql.end();
  const owner = postgres(withDb(admin, name), { max: 1, onnotice: () => undefined });
  // pg-boss creates its own schema as the runtime role.
  await owner.unsafe(`grant create on database ${name} to crmbee_app`);
  await owner.end();
  const appUrl = withDb(admin, name).replace('postgres@', 'crmbee_app:crmbee_app@');
  return {
    name, appUrl, ownerUrl: withDb(admin, name),
    async drop() {
      const s = postgres(admin, { max: 1, onnotice: () => undefined });
      await s.unsafe(`drop database if exists ${name} with (force)`);
      await s.end();
    },
  };
}

export function ownerSql(db: TestDb): postgres.Sql {
  return postgres(db.ownerUrl, { max: 2, onnotice: () => undefined });
}
