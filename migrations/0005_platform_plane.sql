-- Platform plane (BRD §4, TEN-02, TEN-05, G1): companies are provisioned by named platform operators from the
-- platform console; credentials created for them live in an encrypted vault, referenced as db:<name>.

ALTER TABLE "platform_operators" ADD COLUMN IF NOT EXISTS "twenty_member_id" varchar(255);
ALTER TABLE "platform_operators" ADD COLUMN IF NOT EXISTS "invited_at" timestamp with time zone;
CREATE UNIQUE INDEX IF NOT EXISTS "platform_operators_member_uq" ON "platform_operators" ("twenty_member_id") WHERE twenty_member_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS "secret_vault" (
	"name" varchar(255) PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- One row per company creation, so a failed run resumes at the failed step and never duplicates a workspace.
CREATE TABLE IF NOT EXISTS "company_provisioning" (
	"slug" varchar(63) PRIMARY KEY NOT NULL,
	"state" varchar(20) DEFAULT 'running' NOT NULL,
	"request" jsonb NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"tenant_id" uuid,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_provisioning_state_ck" CHECK ("state" IN ('running', 'failed', 'ready'))
);

CREATE TABLE IF NOT EXISTS "platform_audit_log" (
	"id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"operator_id" varchar(64) NOT NULL,
	"operator_name" varchar(255) NOT NULL,
	"action" varchar(100) NOT NULL,
	"tenant_id" uuid,
	"target" varchar(255),
	"result" varchar(20) DEFAULT 'success' NOT NULL,
	"metadata" jsonb
);
CREATE INDEX IF NOT EXISTS "platform_audit_at_idx" ON "platform_audit_log" ("at");

CREATE OR REPLACE FUNCTION platform_audit_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'platform_audit_log is append-only'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS platform_audit_no_change ON platform_audit_log;
CREATE TRIGGER platform_audit_no_change BEFORE UPDATE OR DELETE ON platform_audit_log FOR EACH ROW EXECUTE FUNCTION platform_audit_immutable();

-- Platform-plane tables are readable only in an explicit system transaction, never inside a tenant one.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['secret_vault', 'company_provisioning', 'platform_audit_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS platform_only ON %I', t);
    EXECUTE format($p$CREATE POLICY platform_only ON %I USING (current_setting('app.system', true) = 'on') WITH CHECK (current_setting('app.system', true) = 'on')$p$, t);
  END LOOP;
END $$;

-- Grants for tables created after 0002 (default privileges only cover objects created by the same role afterwards).
DO $$
DECLARE s text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmbee_app') THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO crmbee_app', s);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO crmbee_app', s);
  END IF;
END $$;
