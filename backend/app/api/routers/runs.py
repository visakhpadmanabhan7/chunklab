import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_arq, get_session
from app.core.config import get_settings
from app.db.models_core import Project, Run, RunCombination
from app.schemas.run import CombinationOut, RunCreate, RunDetail, RunOut
from app.services.chunking.expander import expand

router = APIRouter(tags=["runs"])
settings = get_settings()


@router.post("/projects/{project_id}/runs", response_model=RunOut, status_code=201)
async def create_run(
    project_id: uuid.UUID,
    body: RunCreate,
    session: AsyncSession = Depends(get_session),
    arq=Depends(get_arq),
):
    project = await session.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    try:
        combos = expand([c.model_dump() for c in body.combinations])
    except KeyError as exc:
        raise HTTPException(400, str(exc))
    if not combos:
        raise HTTPException(400, "No valid combinations")

    file_ids = body.file_ids if body.file_ids == "all" else [str(f) for f in body.file_ids]

    run = Run(
        project_id=project_id,
        name=body.name,
        config={"file_ids": file_ids, "combinations": [c.model_dump() for c in body.combinations]},
        embedding_model=settings.EMBEDDING_MODEL,
        top_k=body.top_k or settings.TOP_K,
        status="queued",
        total_combinations=len(combos),
    )
    session.add(run)
    await session.flush()

    for c in combos:
        session.add(
            RunCombination(
                run_id=run.id, strategy=c.strategy, params=c.params, label=c.label, status="queued"
            )
        )
    await session.commit()
    await session.refresh(run)

    await arq.enqueue_job("run_pipeline", str(run.id))
    return RunOut.model_validate(run)


@router.get("/projects/{project_id}/runs", response_model=list[RunOut])
async def list_runs(project_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    rows = await session.execute(
        select(Run).where(Run.project_id == project_id).order_by(Run.created_at.desc())
    )
    return [RunOut.model_validate(r) for r in rows.scalars().all()]


@router.get("/runs/{run_id}", response_model=RunDetail)
async def get_run(run_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    run = await session.get(Run, run_id)
    if not run:
        raise HTTPException(404, "Run not found")
    combos = (
        await session.execute(
            select(RunCombination).where(RunCombination.run_id == run_id).order_by(RunCombination.label)
        )
    ).scalars().all()
    detail = RunDetail.model_validate(run)
    detail.combinations = [CombinationOut.model_validate(c) for c in combos]
    return detail


@router.get("/runs/{run_id}/combinations", response_model=list[CombinationOut])
async def list_combinations(run_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    rows = await session.execute(
        select(RunCombination).where(RunCombination.run_id == run_id).order_by(RunCombination.label)
    )
    return [CombinationOut.model_validate(c) for c in rows.scalars().all()]


@router.post("/runs/{run_id}/cancel", response_model=RunOut)
async def cancel_run(run_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    run = await session.get(Run, run_id)
    if not run:
        raise HTTPException(404, "Run not found")
    if run.status in ("queued", "running"):
        run.status = "canceled"
        await session.commit()
        await session.refresh(run)
    return RunOut.model_validate(run)
