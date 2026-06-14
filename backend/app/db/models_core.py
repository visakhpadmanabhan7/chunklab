"""`core` schema — application data."""

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import func

from app.db.base import CoreBase, TimestampMixin


def _pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


class Project(CoreBase, TimestampMixin):
    __tablename__ = "projects"
    __table_args__ = {"schema": "core"}

    id: Mapped[uuid.UUID] = _pk()
    user_id: Mapped[str] = mapped_column(String(128), default="anonymous", index=True)
    name: Mapped[str] = mapped_column(String(256))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        server_default=func.now(), onupdate=func.now()
    )

    files: Mapped[list["File"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    runs: Mapped[list["Run"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )


class File(CoreBase, TimestampMixin):
    __tablename__ = "files"
    __table_args__ = {"schema": "core"}

    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("core.projects.id", ondelete="CASCADE"), index=True
    )
    filename: Mapped[str] = mapped_column(String(512))
    storage_path: Mapped[str] = mapped_column(Text)
    mime_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # uploaded | parsing | parsed | failed
    status: Mapped[str] = mapped_column(String(32), default="uploaded", index=True)
    parser_used: Mapped[str | None] = mapped_column(String(32), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # user-chosen parsing options: {parser: docling|fast, ocr: bool, tables: bool}
    parse_options: Mapped[dict] = mapped_column(JSONB, default=dict)

    project: Mapped["Project"] = relationship(back_populates="files")
    parsed: Mapped["ParsedDocument | None"] = relationship(
        back_populates="file", cascade="all, delete-orphan", uselist=False
    )


class ParsedDocument(CoreBase):
    __tablename__ = "parsed_documents"
    __table_args__ = {"schema": "core"}

    id: Mapped[uuid.UUID] = _pk()
    file_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("core.files.id", ondelete="CASCADE"), unique=True, index=True
    )
    clean_text: Mapped[str] = mapped_column(Text)
    char_count: Mapped[int] = mapped_column(Integer, default=0)
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    parsed_at: Mapped[datetime] = mapped_column(server_default=func.now())

    file: Mapped["File"] = relationship(back_populates="parsed")


class Run(CoreBase, TimestampMixin):
    __tablename__ = "runs"
    __table_args__ = {"schema": "core"}

    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("core.projects.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(256))
    config: Mapped[dict] = mapped_column(JSONB, default=dict)
    embedding_model: Mapped[str] = mapped_column(String(128))
    top_k: Mapped[int] = mapped_column(Integer, default=5)
    # queued | running | completed | failed | partial | canceled
    status: Mapped[str] = mapped_column(String(32), default="queued", index=True)
    progress: Mapped[float] = mapped_column(default=0.0)
    total_combinations: Mapped[int] = mapped_column(Integer, default=0)
    started_at: Mapped[datetime | None] = mapped_column(nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    project: Mapped["Project"] = relationship(back_populates="runs")
    combinations: Mapped[list["RunCombination"]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )


class RunCombination(CoreBase, TimestampMixin):
    __tablename__ = "run_combinations"
    __table_args__ = {"schema": "core"}

    id: Mapped[uuid.UUID] = _pk()
    run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("core.runs.id", ondelete="CASCADE"), index=True
    )
    strategy: Mapped[str] = mapped_column(String(32))
    params: Mapped[dict] = mapped_column(JSONB, default=dict)
    label: Mapped[str] = mapped_column(String(128))
    # queued | chunking | embedding | evaluating | completed | failed
    status: Mapped[str] = mapped_column(String(32), default="queued", index=True)
    progress: Mapped[float] = mapped_column(default=0.0)

    run: Mapped["Run"] = relationship(back_populates="combinations")
