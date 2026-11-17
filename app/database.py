from datetime import datetime, timezone
from typing import Annotated, Optional

from fastapi import Depends
from sqlalchemy import DateTime, MetaData, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.types import TypeDecorator

from app import config

IS_SQLITE = config.DATABASE_URL.startswith("sqlite")

engine = create_engine(
    config.DATABASE_URL,
    connect_args={"check_same_thread": False} if IS_SQLITE else {},
)

if IS_SQLITE:
    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _record):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")   # SQLite ignores FKs without this
        cur.execute("PRAGMA journal_mode=WAL")  # readers don't block the writer
        cur.close()

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


# Named constraints, so migrations can alter them later (SQLite rebuilds tables, and needs the names).
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


class UTCDateTime(TypeDecorator):
    """Always stores UTC and always returns timezone-aware UTC datetimes.

    SQLite has no timezone support and returns naive datetimes, which breaks
    comparisons with datetime.now(timezone.utc) and makes browsers treat the
    value as local time. This type fixes both, on every database.
    """

    impl = DateTime
    cache_ok = True

    def __init__(self):
        super().__init__(timezone=True)

    def process_bind_param(self, value: Optional[datetime], dialect):
        if value is not None:
            if value.tzinfo is None:
                value = value.replace(tzinfo=timezone.utc)
            value = value.astimezone(timezone.utc)
        return value

    def process_result_value(self, value: Optional[datetime], dialect):
        if value is not None and value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value


def get_db():
    with SessionLocal() as db:
        yield db


DB = Annotated[Session, Depends(get_db)]


def init_db() -> None:
    """Bring the database up to the latest migration (the tables are created by Alembic, not by the app).

    Set AUTO_MIGRATE=0 to skip this and run `alembic upgrade head` yourself, e.g. as a deploy step.
    """
    if not config.AUTO_MIGRATE:
        return
    from alembic import command
    from alembic.config import Config

    command.upgrade(Config(str(config.PROJECT_DIR / "alembic.ini")), "head")
