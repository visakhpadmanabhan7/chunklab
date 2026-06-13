"""`results` schema — experiment output, including pgvector embeddings."""

import uuid

from pgvector.sqlalchemy import Vector
from sqlalchemy import Float, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.config import get_settings
from app.db.base import ResultsBase, TimestampMixin

EMBEDDING_DIM = get_settings().EMBEDDING_DIM


def _pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


class Chunk(ResultsBase, TimestampMixin):
    __tablename__ = "chunks"

    id: Mapped[uuid.UUID] = _pk()
    combination_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("core.run_combinations.id", ondelete="CASCADE"), index=True
    )
    file_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("core.files.id", ondelete="CASCADE"), index=True
    )
    chunk_index: Mapped[int] = mapped_column(Integer)
    content: Mapped[str] = mapped_column(Text)
    token_count: Mapped[int] = mapped_column(Integer, default=0)
    char_count: Mapped[int] = mapped_column(Integer, default=0)
    embedding: Mapped[list[float]] = mapped_column(Vector(EMBEDDING_DIM))


class CombinationStats(ResultsBase, TimestampMixin):
    __tablename__ = "combination_stats"

    id: Mapped[uuid.UUID] = _pk()
    combination_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("core.run_combinations.id", ondelete="CASCADE"),
        unique=True,
        index=True,
    )
    chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0)
    avg_tokens_per_chunk: Mapped[float] = mapped_column(Float, default=0.0)
    embedding_cost_usd: Mapped[float] = mapped_column(Numeric(12, 6), default=0)
    judge_cost_usd: Mapped[float] = mapped_column(Numeric(12, 6), default=0)
    total_cost_usd: Mapped[float] = mapped_column(Numeric(12, 6), default=0)
    chunk_latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    embed_latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    eval_latency_ms: Mapped[int] = mapped_column(Integer, default=0)


class QAPair(ResultsBase, TimestampMixin):
    __tablename__ = "qa_pairs"

    id: Mapped[uuid.UUID] = _pk()
    run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("core.runs.id", ondelete="CASCADE"), index=True
    )
    file_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("core.files.id", ondelete="CASCADE"), index=True
    )
    question: Mapped[str] = mapped_column(Text)
    reference_answer: Mapped[str] = mapped_column(Text)
    source_chunk_text: Mapped[str] = mapped_column(Text)
    source_offset_start: Mapped[int] = mapped_column(Integer, default=0)
    source_offset_end: Mapped[int] = mapped_column(Integer, default=0)


class Retrieval(ResultsBase, TimestampMixin):
    __tablename__ = "retrievals"

    id: Mapped[uuid.UUID] = _pk()
    combination_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("core.run_combinations.id", ondelete="CASCADE"), index=True
    )
    qa_pair_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("results.qa_pairs.id", ondelete="CASCADE"), index=True
    )
    retrieved_chunk_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(UUID(as_uuid=True)), default=list
    )
    scores: Mapped[list[float]] = mapped_column(ARRAY(Float), default=list)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)


class JudgeEvaluation(ResultsBase, TimestampMixin):
    __tablename__ = "judge_evaluations"

    id: Mapped[uuid.UUID] = _pk()
    retrieval_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("results.retrievals.id", ondelete="CASCADE"),
        unique=True,
        index=True,
    )
    relevance: Mapped[float] = mapped_column(Float, default=0.0)
    faithfulness: Mapped[float] = mapped_column(Float, default=0.0)
    context_precision: Mapped[float] = mapped_column(Float, default=0.0)
    context_recall: Mapped[float] = mapped_column(Float, default=0.0)
    judge_feedback: Mapped[str | None] = mapped_column(Text, nullable=True)
    judge_model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    judge_tokens_in: Mapped[int] = mapped_column(Integer, default=0)
    judge_tokens_out: Mapped[int] = mapped_column(Integer, default=0)


class Metrics(ResultsBase, TimestampMixin):
    __tablename__ = "metrics"

    id: Mapped[uuid.UUID] = _pk()
    combination_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("core.run_combinations.id", ondelete="CASCADE"),
        unique=True,
        index=True,
    )
    # LLM-judged means
    relevance: Mapped[float] = mapped_column(Float, default=0.0)
    faithfulness: Mapped[float] = mapped_column(Float, default=0.0)
    context_precision: Mapped[float] = mapped_column(Float, default=0.0)
    context_recall: Mapped[float] = mapped_column(Float, default=0.0)
    # computed IR metrics
    precision_at_k: Mapped[float] = mapped_column(Float, default=0.0)
    recall_at_k: Mapped[float] = mapped_column(Float, default=0.0)
    mrr: Mapped[float] = mapped_column(Float, default=0.0)
    ndcg_at_k: Mapped[float] = mapped_column(Float, default=0.0)
    f2: Mapped[float] = mapped_column(Float, default=0.0)
    avg_retrieval_latency_ms: Mapped[float] = mapped_column(Float, default=0.0)
