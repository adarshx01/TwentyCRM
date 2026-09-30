from __future__ import annotations

import uuid
from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from conversation.models import Base


def make_engine(database_url: str):
    if database_url.startswith("sqlite"):
        return create_engine(
            database_url,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
    return create_engine(database_url)


def make_session_factory(database_url: str) -> sessionmaker[Session]:
    engine = make_engine(database_url)
    return sessionmaker(bind=engine, expire_on_commit=False)


def create_schema(engine) -> None:
    Base.metadata.create_all(engine)


def bind_tenant(session: Session, tenant_id: uuid.UUID) -> None:
    """Set the Postgres RLS tenant GUC for this transaction.

    SQLite has no RLS. Callers still filter every query by tenant_id.
    Superuser connections ignore the policies; use conversation_app.
    """
    bind = session.get_bind()
    if bind is None or bind.dialect.name != "postgresql":
        return
    session.execute(
        text("SELECT set_config('app.tenant_id', :tid, true)"),
        {"tid": str(tenant_id)},
    )


@contextmanager
def tenant_session(factory: sessionmaker[Session], tenant_id: uuid.UUID) -> Iterator[Session]:
    session = factory()
    try:
        bind_tenant(session, tenant_id)
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
