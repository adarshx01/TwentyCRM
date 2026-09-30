-- Local-only password, same idea as infra/twenty's default postgres user.
-- The API connects as conversation_app so FORCE ROW LEVEL SECURITY applies.
-- The compose superuser `conversation` is for Alembic only.
CREATE ROLE conversation_app LOGIN PASSWORD 'conversation_app' NOSUPERUSER NOBYPASSRLS;
