-- Development bootstrap. In production create these roles with managed-database tooling (see terraform/).
-- crmbee_owner  runs migrations (owns the tables)
-- crmbee_app    runtime role: NOT a superuser and NOT the table owner, so row-level security is enforced (TEN-03)
CREATE ROLE crmbee_owner LOGIN PASSWORD 'crmbee_owner';
CREATE ROLE crmbee_app LOGIN PASSWORD 'crmbee_app' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE crmbee OWNER crmbee_owner;
CREATE DATABASE twenty;
\c crmbee
GRANT CREATE ON DATABASE crmbee TO crmbee_app;  -- pg-boss creates its own schema as the runtime role
GRANT ALL ON SCHEMA public TO crmbee_owner;
