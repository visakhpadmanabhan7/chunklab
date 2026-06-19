import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_session
from app.db.models_core import Run, RunCombination
from app.db.models_results import Chunk, QAPair, QueryMetric
from app.services.reporting import build_run_report

router = APIRouter(tags=["results"])


@router.get("/runs/{run_id}/results")
async def run_results(run_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    run = await session.get(Run, run_id)
    if not run:
        raise HTTPException(404, "Run not found")
    return {
        "run_id": str(run_id),
        "name": run.name,
        "status": run.status,
        "top_k": run.top_k,
        "combinations": await build_run_report(session, run_id),
    }


@router.get("/combinations/{combination_id}/chunks")
async def combination_chunks(
    combination_id: uuid.UUID,
    limit: int = 50,
    offset: int = 0,
    session: AsyncSession = Depends(get_session),
):
    stmt = (
        select(Chunk.id, Chunk.file_id, Chunk.chunk_index, Chunk.content, Chunk.token_count, Chunk.char_count)
        .where(Chunk.combination_id == combination_id)
        .order_by(Chunk.file_id, Chunk.chunk_index)
        .limit(min(limit, 200))
        .offset(offset)
    )
    rows = (await session.execute(stmt)).all()
    return [
        {
            "id": str(r.id),
            "file_id": str(r.file_id),
            "chunk_index": r.chunk_index,
            "content": r.content,
            "token_count": r.token_count,
            "char_count": r.char_count,
        }
        for r in rows
    ]


@router.get("/runs/{run_id}/per-question")
async def run_per_question(run_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    """Disaggregated results — one row per (combination × question)."""
    stmt = (
        select(
            RunCombination.label,
            RunCombination.strategy,
            QAPair.question,
            QueryMetric,
        )
        .join(QueryMetric, QueryMetric.combination_id == RunCombination.id)
        .join(QAPair, QAPair.id == QueryMetric.qa_pair_id)
        .where(RunCombination.run_id == run_id)
        .order_by(RunCombination.label, QAPair.created_at)
    )
    rows = (await session.execute(stmt)).all()
    return [
        {
            "label": label,
            "strategy": strategy,
            "question": question,
            "precision_at_k": m.precision_at_k,
            "recall_at_k": m.recall_at_k,
            "mrr": m.mrr,
            "ndcg_at_k": m.ndcg_at_k,
            "f2": m.f2,
            "relevance": m.relevance,
            "faithfulness": m.faithfulness,
            "context_precision": m.context_precision,
            "context_recall": m.context_recall,
        }
        for (label, strategy, question, m) in rows
    ]


@router.get("/runs/{run_id}/qa-pairs")
async def run_qa_pairs(run_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    rows = (
        await session.execute(select(QAPair).where(QAPair.run_id == run_id))
    ).scalars().all()
    return [
        {
            "id": str(q.id),
            "file_id": str(q.file_id),
            "question": q.question,
            "reference_answer": q.reference_answer,
        }
        for q in rows
    ]
