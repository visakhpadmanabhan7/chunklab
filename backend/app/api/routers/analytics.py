import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_session
from app.db.models_core import Run
from app.services.reporting import build_run_report

router = APIRouter(tags=["analytics"])


@router.get("/runs/{run_id}/analytics/compare")
async def compare(run_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    run = await session.get(Run, run_id)
    if not run:
        raise HTTPException(404, "Run not found")
    return {"run_id": str(run_id), "combinations": await build_run_report(session, run_id)}


@router.get("/runs/{run_id}/analytics/tradeoff")
async def tradeoff(run_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    run = await session.get(Run, run_id)
    if not run:
        raise HTTPException(404, "Run not found")
    report = await build_run_report(session, run_id)
    points = [
        {
            "label": r["label"],
            "strategy": r["strategy"],
            "cost": r["total_cost_usd"],
            "accuracy": r["ndcg_at_k"],
            "latency_ms": r["avg_retrieval_latency_ms"],
            "tokens": r["total_tokens"],
        }
        for r in report
    ]
    return {"run_id": str(run_id), "points": points}


@router.get("/projects/{project_id}/analytics/runs")
async def project_runs_summary(
    project_id: uuid.UUID, session: AsyncSession = Depends(get_session)
):
    runs = (
        await session.execute(
            select(Run).where(Run.project_id == project_id).order_by(Run.created_at.desc())
        )
    ).scalars().all()

    summary = []
    for run in runs:
        report = await build_run_report(session, run.id)
        best = max(report, key=lambda r: r["ndcg_at_k"], default=None)
        summary.append(
            {
                "run_id": str(run.id),
                "name": run.name,
                "status": run.status,
                "combinations": len(report),
                "best_label": best["label"] if best else None,
                "best_ndcg": best["ndcg_at_k"] if best else 0.0,
                "total_cost_usd": round(sum(r["total_cost_usd"] for r in report), 6),
                "total_tokens": sum(r["total_tokens"] for r in report),
            }
        )
    return {"project_id": str(project_id), "runs": summary}
