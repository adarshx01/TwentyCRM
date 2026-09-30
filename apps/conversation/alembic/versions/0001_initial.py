"""App schema and Postgres row-level security.

SQLite unit tests create the same tables through SQLAlchemy metadata and do
not execute this revision. On Postgres, run `alembic upgrade head` as the
migration superuser (see infra/conversation). Policies are forced. The API
role is conversation_app, which does not bypass RLS.

CREATE ROLE cannot run inside a transaction block, so that statement uses
an autocommit block. Each later statement is executed on its own so psycopg
does not reject a multi-command string.

Revision ID: 0001_initial
Revises:
Create Date: 2026-10-01
"""

from alembic import op

from conversation.models import Base
from conversation.tenancy.rls import rls_statements

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    Base.metadata.create_all(bind=bind)
    statements = rls_statements()
    role_sql, rest = statements[0], statements[1:]
    with op.get_context().autocommit_block():
        op.execute(role_sql)
    for statement in rest:
        op.execute(statement)


def downgrade() -> None:
    bind = op.get_bind()
    Base.metadata.drop_all(bind=bind)
