-- Row-level security (TEN-03). Policies apply to every non-superuser role,
-- including the table owner (FORCE). Tenant code runs inside a transaction that
-- calls set_config('app.tenant_id', <id>, true); the transaction-local setting
-- cannot leak through a transaction-pooled connection. Cross-tenant system
-- work (scheduler claims, binding lookup) sets app.system = 'on' explicitly.

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON users;
CREATE POLICY tenant_isolation ON users
  USING (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on')
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on');

ALTER TABLE channel_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON channel_bindings;
CREATE POLICY tenant_isolation ON channel_bindings
  USING (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on')
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on');

ALTER TABLE enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON enrollments;
CREATE POLICY tenant_isolation ON enrollments
  USING (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on')
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on');

ALTER TABLE drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE drafts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON drafts;
CREATE POLICY tenant_isolation ON drafts
  USING (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on')
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on');

ALTER TABLE operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON operations;
CREATE POLICY tenant_isolation ON operations
  USING (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on')
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on');

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON idempotency_keys;
CREATE POLICY tenant_isolation ON idempotency_keys
  USING (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on')
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on');

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_log;
CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on')
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on');

ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON schedules;
CREATE POLICY tenant_isolation ON schedules
  USING (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on')
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on');

ALTER TABLE delivery_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON delivery_state;
CREATE POLICY tenant_isolation ON delivery_state
  USING (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on')
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on');

ALTER TABLE intake_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_sources FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON intake_sources;
CREATE POLICY tenant_isolation ON intake_sources
  USING (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on')
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on');

ALTER TABLE intake_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON intake_records;
CREATE POLICY tenant_isolation ON intake_records
  USING (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on')
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on');

ALTER TABLE mailbox_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailbox_checkpoints FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mailbox_checkpoints;
CREATE POLICY tenant_isolation ON mailbox_checkpoints
  USING (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on')
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on');

ALTER TABLE crm_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_index FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON crm_index;
CREATE POLICY tenant_isolation ON crm_index
  USING (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on')
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on');

ALTER TABLE stage_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE stage_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON stage_history;
CREATE POLICY tenant_isolation ON stage_history
  USING (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on')
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on');

ALTER TABLE reconciliation_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON reconciliation_state;
CREATE POLICY tenant_isolation ON reconciliation_state
  USING (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on')
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on');

ALTER TABLE media_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_objects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON media_objects;
CREATE POLICY tenant_isolation ON media_objects
  USING (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on')
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on');

ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON usage_events;
CREATE POLICY tenant_isolation ON usage_events
  USING (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on')
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on');


-- Audit trail is append-only. Retention purges must set app.audit_purge = 'on'.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.audit_purge', true) = 'on' AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_log_no_change ON audit_log;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- Draft state machine guard: terminal states never move again (ACT-04).
CREATE OR REPLACE FUNCTION drafts_terminal_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.state IN ('committed','cancelled','expired') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'draft % is terminal (%)', OLD.id, OLD.state;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS drafts_terminal ON drafts;
CREATE TRIGGER drafts_terminal BEFORE UPDATE ON drafts
  FOR EACH ROW EXECUTE FUNCTION drafts_terminal_guard();

-- Grants for the runtime role when it exists (created by infrastructure code). Schema-agnostic: works in `public`
-- or a dedicated schema (e.g. `crmbee` on Supabase) because it uses the schema the migration runs in.
DO $$
DECLARE s text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmbee_app') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO crmbee_app', s);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO crmbee_app', s);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO crmbee_app', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crmbee_app', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO crmbee_app', s);
  END IF;
END $$;
