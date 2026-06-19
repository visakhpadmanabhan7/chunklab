import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_session
from app.core.logging import get_logger
from app.db.models_core import Project, ProjectQAPair

router = APIRouter(tags=["qa-sets"])
logger = get_logger(__name__)


class QAItemIn(BaseModel):
    question: str
    reference_answer: str
    source_file: str | None = None
    source_chunk_text: str | None = None


class QAItemOut(QAItemIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID


@router.get("/projects/{project_id}/qa-set", response_model=list[QAItemOut])
async def list_qa(project_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    rows = (
        await session.execute(
            select(ProjectQAPair)
            .where(ProjectQAPair.project_id == project_id)
            .order_by(ProjectQAPair.created_at)
        )
    ).scalars().all()
    return [QAItemOut.model_validate(r) for r in rows]


@router.post("/projects/{project_id}/qa-set", response_model=list[QAItemOut], status_code=201)
async def add_qa(
    project_id: uuid.UUID,
    items: list[QAItemIn],
    session: AsyncSession = Depends(get_session),
):
    if not await session.get(Project, project_id):
        raise HTTPException(404, "Project not found")
    created: list[ProjectQAPair] = []
    for it in items:
        if not it.question.strip() or not it.reference_answer.strip():
            continue
        row = ProjectQAPair(
            project_id=project_id,
            question=it.question.strip(),
            reference_answer=it.reference_answer.strip(),
            source_file=it.source_file or None,
            source_chunk_text=it.source_chunk_text or None,
        )
        session.add(row)
        created.append(row)
    await session.commit()
    for r in created:
        await session.refresh(r)
    logger.info("qa-set: added %d items to project=%s", len(created), project_id)
    return [QAItemOut.model_validate(r) for r in created]


@router.delete("/qa-set/{item_id}", status_code=204)
async def delete_qa(item_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    row = await session.get(ProjectQAPair, item_id)
    if row:
        await session.delete(row)
        await session.commit()
