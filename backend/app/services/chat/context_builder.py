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


def _winners(report: list[dict]) -> str:
    """A pre-computed leaderboard so the model reads answers off rather than
    re-deriving them from the table (weak models otherwise misread/hallucinate)."""
    if not report:
        return ""

    def top(key: str, lo: bool = False):
        return (min if lo else max)(report, key=lambda r: r.get(key) or 0)

    bn, br, bp, bf = top("ndcg_at_k"), top("recall_at_k"), top("precision_at_k"), top("faithfulness")
    cheap = top("total_cost_usd", lo=True)
    fast = min(report, key=lambda r: r.get("avg_retrieval_latency_ms") or 1e12)
    ranked = sorted(report, key=lambda r: r.get("ndcg_at_k") or 0, reverse=True)
    ranking = " > ".join(f"{r['label']} ({(r.get('ndcg_at_k') or 0):.3f})" for r in ranked)
    worst = ranked[-1]
    return (
        f"### Leaderboard (this run, {len(report)} combinations) — read answers from here\n"
        f"- best nDCG (overall accuracy): {bn['label']} ({bn['ndcg_at_k']:.4f})\n"
        f"- best recall@k: {br['label']} ({br['recall_at_k']:.4f})\n"
        f"- best precision@k: {bp['label']} ({bp['precision_at_k']:.4f})\n"
        f"- best faithfulness: {bf['label']} ({bf['faithfulness']:.4f})\n"
        f"- lowest cost: {cheap['label']} (${cheap['total_cost_usd']:.4f})\n"
        f"- fastest retrieval: {fast['label']} ({fast['avg_retrieval_latency_ms']:.1f} ms)\n"
        f"- overall ranking by nDCG (best to worst): {ranking}\n"
        f"- WEAKEST overall (lowest nDCG): {worst['label']} "
        f"(nDCG {(worst.get('ndcg_at_k') or 0):.4f}, recall {(worst.get('recall_at_k') or 0):.4f}, "
        f"P@k {(worst.get('precision_at_k') or 0):.4f}, MRR {(worst.get('mrr') or 0):.4f}, "
        f"faithfulness {(worst.get('faithfulness') or 0):.4f}) — its full per-metric row is in the table below"
    )


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
        parts.append(_winners(report))
        parts.append(_format_report(f"Run {run_id} — {len(report)} combinations", report))
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
