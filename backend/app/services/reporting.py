"""Shared per-combination report builder (used by results + analytics)."""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models_core import RunCombination
from app.db.models_results import CombinationStats, Metrics


def _f(value) -> float:
    return float(value) if value is not None else 0.0


async def build_run_report(session: AsyncSession, run_id: uuid.UUID) -> list[dict]:
    stmt = (
        select(RunCombination, Metrics, CombinationStats)
        .where(RunCombination.run_id == run_id)
        .outerjoin(Metrics, Metrics.combination_id == RunCombination.id)
        .outerjoin(CombinationStats, CombinationStats.combination_id == RunCombination.id)
        .order_by(RunCombination.label)
    )
    rows = (await session.execute(stmt)).all()

    report: list[dict] = []
    for combo, metrics, stats in rows:
        report.append(
            {
                "combination_id": str(combo.id),
                "label": combo.label,
                "strategy": combo.strategy,
                "params": combo.params,
                "status": combo.status,
                # tokens / cost / latency
                "chunk_count": stats.chunk_count if stats else 0,
                "total_tokens": stats.total_tokens if stats else 0,
                "avg_tokens_per_chunk": _f(stats.avg_tokens_per_chunk) if stats else 0.0,
                "embedding_cost_usd": _f(stats.embedding_cost_usd) if stats else 0.0,
                "judge_cost_usd": _f(stats.judge_cost_usd) if stats else 0.0,
                "total_cost_usd": _f(stats.total_cost_usd) if stats else 0.0,
                "chunk_latency_ms": stats.chunk_latency_ms if stats else 0,
                "embed_latency_ms": stats.embed_latency_ms if stats else 0,
                "eval_latency_ms": stats.eval_latency_ms if stats else 0,
                # accuracy
                "relevance": _f(metrics.relevance) if metrics else 0.0,
                "faithfulness": _f(metrics.faithfulness) if metrics else 0.0,
                "context_precision": _f(metrics.context_precision) if metrics else 0.0,
                "context_recall": _f(metrics.context_recall) if metrics else 0.0,
                "precision_at_k": _f(metrics.precision_at_k) if metrics else 0.0,
                "recall_at_k": _f(metrics.recall_at_k) if metrics else 0.0,
                "mrr": _f(metrics.mrr) if metrics else 0.0,
                "ndcg_at_k": _f(metrics.ndcg_at_k) if metrics else 0.0,
                "f2": _f(metrics.f2) if metrics else 0.0,
                "avg_retrieval_latency_ms": _f(metrics.avg_retrieval_latency_ms) if metrics else 0.0,
            }
        )
    return report
