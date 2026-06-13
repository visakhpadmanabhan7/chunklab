"""Two schema-bound declarative bases.

`core`    — application data (projects, files, runs, combinations)
`results` — experiment output (chunks+vectors, stats, qa, judgments, metrics)

Keeping them in separate Postgres schemas is an explicit requirement: run
results live apart from app data. Cross-schema foreign keys are fully supported.
"""

from datetime import datetime

from sqlalchemy import MetaData
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.sql import func


class CoreBase(DeclarativeBase):
    metadata = MetaData(schema="core")


class ResultsBase(DeclarativeBase):
    metadata = MetaData(schema="results")


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
