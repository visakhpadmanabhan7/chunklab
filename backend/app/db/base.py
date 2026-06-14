"""Single shared MetaData; schema set per-table via __table_args__.

`core`    — application data (projects, files, runs, combinations)
`results` — experiment output (chunks+vectors, stats, qa, judgments, metrics)

One MetaData (rather than one per schema) is required so cross-schema foreign
keys — e.g. results.chunks.file_id -> core.files.id — resolve during create_all.
"""

from datetime import datetime

from sqlalchemy import MetaData
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.sql import func


class Base(DeclarativeBase):
    metadata = MetaData()


# Backwards-compatible aliases used across the models; both map to the one Base.
CoreBase = Base
ResultsBase = Base


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
