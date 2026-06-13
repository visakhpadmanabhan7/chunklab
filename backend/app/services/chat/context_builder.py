"""Build RAG context for the chatbot from stored run results + chunk vectors."""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.embedding import embed_query
from app.db.models_core import Run, RunCombination
from app.db.models_results import Metrics
from app.services.eval.retriever import retrieve
from app.services.reporting import build_run_report

_REPORT_COLS = [
    ("total_tokens", "tokens"),
    ("total_cost_usd", "cost$"),
    ("relevance", "relev"),
    ("faithfulness", "faith"),
    ("precision_at_k", "P@k"),
    ("recall_at_k", "recall"),
    ("mrr", "mrr"),
    ("ndcg_at_k", "ndcg"),
    ("f2", "f2"),
]


def _format_report(name: str, report: list[dict]) -> str:
    header = "combination | " + " | ".join(label for _k, label in _REPORT_COLS)
    lines = [f"### {name}", header]
    for row in report:
        cells = []
        for key, _label in _REPORT_COLS:
            val = row.get(key, 0)
            cells.append(f"{val:.4f}" if isinstance(val, float) else str(val))
        lines.append(f"{row['label']} | " + " | ".join(cells))
    return "\n".join(lines)


async def _best_combination_id(session: AsyncSession, run_id: uuid.UUID) -> uuid.UUID | None:
    stmt = (
        select(RunCombination.id)
        .join(Metrics, Metrics.combination_id == RunCombination.id)
        .where(RunCombination.run_id == run_id)
        .order_by(Metrics.ndcg_at_k.desc())
        .limit(1)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def _retrieve_snippets(
    session: AsyncSession, run_id: uuid.UUID, query: str, k: int = 5
) -> list[str]:
    combo_id = await _best_combination_id(session, run_id)
    if combo_id is None:
        return []
    qvec = embed_query(query)
    retrieved = await retrieve(session, combo_id, qvec, k)
    return [f"[{run_id} · chunk] {r.content[:500]}" for r in retrieved]


async def build_context(
    session: AsyncSession,
    scope: str,
    query: str,
    project_id: uuid.UUID | None = None,
    run_id: uuid.UUID | None = None,
    run_ids: list[uuid.UUID] | None = None,
) -> str:
    parts: list[str] = []

    if scope == "run" and run_id:
        report = await build_run_report(session, run_id)
        parts.append(_format_report(f"Run {run_id}", report))
        parts += await _retrieve_snippets(session, run_id, query)

    elif scope == "compare" and run_ids:
        for rid in run_ids[:2]:
            report = await build_run_report(session, rid)
            parts.append(_format_report(f"Run {rid}", report))
        for rid in run_ids[:2]:
            parts += await _retrieve_snippets(session, rid, query, k=3)

    elif scope == "project" and project_id:
        rows = (
            await session.execute(
                select(Run)
                .where(Run.project_id == project_id, Run.status == "completed")
                .order_by(Run.created_at.desc())
                .limit(5)
            )
        ).scalars().all()
        for run in rows:
            report = await build_run_report(session, run.id)
            parts.append(_format_report(f"Run '{run.name}' ({run.id})", report))
        if rows:
            parts += await _retrieve_snippets(session, rows[0].id, query)

    return "\n\n".join(parts) if parts else "(no run results available yet)"
