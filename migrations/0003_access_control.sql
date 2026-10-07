-- Access control (BRD §4, IAM-01..05; docs/access-architecture.md).
-- Teams, archive requests, named platform operators and client-approved support grants.

-- Backfills read tenant tables, which are FORCE row-level secured even for the owner: act as the system (tx-local).
SELECT set_config('app.system', 'on', true);

CREATE TABLE IF NOT EXISTS "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE restrict,
	"key" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_tenant_key_uq" UNIQUE ("tenant_id", "key")
);

CREATE TABLE IF NOT EXISTS "archive_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE restrict,
	"requested_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"target_type" varchar(20) NOT NULL,
	"target_id" varchar(255) NOT NULL,
	"target_label" varchar(255) NOT NULL,
	"target_owner_key" varchar(255),
	"target_team_id" varchar(255),
	"reason" text,
	"state" varchar(20) DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"operation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "archive_requests_target_type_ck" CHECK ("target_type" IN ('person', 'company', 'opportunity')),
	CONSTRAINT "archive_requests_state_ck" CHECK ("state" IN ('pending', 'approved', 'rejected', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS "archive_requests_tenant_state_idx" ON "archive_requests" ("tenant_id", "state");
CREATE UNIQUE INDEX IF NOT EXISTS "archive_requests_one_pending_uq" ON "archive_requests" ("tenant_id", "target_type", "target_id") WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS "platform_operators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL UNIQUE,
	"key_hash" varchar(64) NOT NULL UNIQUE,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_by" varchar(255) NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "support_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE restrict,
	"operator_id" uuid NOT NULL REFERENCES "platform_operators"("id") ON DELETE restrict,
	"reason" text NOT NULL,
	"access" varchar(20) DEFAULT 'read' NOT NULL,
	"hours" integer DEFAULT 4 NOT NULL,
	"state" varchar(20) DEFAULT 'requested' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_grants_state_ck" CHECK ("state" IN ('requested', 'active', 'denied', 'revoked')),
	CONSTRAINT "support_grants_hours_ck" CHECK ("hours" BETWEEN 1 AND 72)
);
CREATE INDEX IF NOT EXISTS "support_grants_tenant_idx" ON "support_grants" ("tenant_id", "state");

-- Employees hold tenant roles only; the platform operator is a separate principal (decision in §1).
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_role_tenant_only_ck";
ALTER TABLE "users" ADD CONSTRAINT "users_role_tenant_only_ck" CHECK ("role" IN ('salesperson', 'manager', 'cxo', 'client_admin'));

-- Teams referenced by existing users become real rows (idempotent backfill).
INSERT INTO "teams" ("tenant_id", "key", "name")
SELECT DISTINCT u."tenant_id", t.key, t.key
FROM "users" u
CROSS JOIN LATERAL (
	SELECT u."team_id" AS key WHERE u."team_id" IS NOT NULL
	UNION SELECT jsonb_array_elements_text(u."managed_team_ids")
) t
ON CONFLICT ("tenant_id", "key") DO NOTHING;

-- Tenant isolation (TEN-03), same policy shape as 0002.
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON teams;
CREATE POLICY tenant_isolation ON teams
  USING (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on')
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on');

ALTER TABLE archive_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON archive_requests;
CREATE POLICY tenant_isolation ON archive_requests
  USING (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on')
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on');

ALTER TABLE support_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_grants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON support_grants;
CREATE POLICY tenant_isolation ON support_grants
  USING (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on')
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on');

-- Operators belong to the platform plane: readable only in an explicit system transaction, never in a tenant one.
ALTER TABLE platform_operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_operators FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_only ON platform_operators;
CREATE POLICY platform_only ON platform_operators
  USING (current_setting('app.system', true) = 'on')
  WITH CHECK (current_setting('app.system', true) = 'on');
