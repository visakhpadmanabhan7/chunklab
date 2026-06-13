import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_session
from app.db.models_core import File, Project, Run
from app.schemas.project import ProjectCreate, ProjectOut, ProjectUpdate

router = APIRouter(prefix="/projects", tags=["projects"])


async def _counts(session: AsyncSession) -> tuple[dict, dict]:
    file_rows = await session.execute(
        select(File.project_id, func.count()).group_by(File.project_id)
    )
    run_rows = await session.execute(
        select(Run.project_id, func.count()).group_by(Run.project_id)
    )
    return dict(file_rows.all()), dict(run_rows.all())


def _to_out(project: Project, files: dict, runs: dict) -> ProjectOut:
    out = ProjectOut.model_validate(project)
    out.file_count = files.get(project.id, 0)
    out.run_count = runs.get(project.id, 0)
    return out


@router.post("", response_model=ProjectOut, status_code=201)
async def create_project(body: ProjectCreate, session: AsyncSession = Depends(get_session)):
    project = Project(name=body.name, description=body.description)
    session.add(project)
    await session.commit()
    await session.refresh(project)
    return _to_out(project, {}, {})


@router.get("", response_model=list[ProjectOut])
async def list_projects(session: AsyncSession = Depends(get_session)):
    projects = (
        (await session.execute(select(Project).order_by(Project.created_at.desc())))
        .scalars()
        .all()
    )
    files, runs = await _counts(session)
    return [_to_out(p, files, runs) for p in projects]


@router.get("/{project_id}", response_model=ProjectOut)
async def get_project(project_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    project = await session.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    files, runs = await _counts(session)
    return _to_out(project, files, runs)


@router.patch("/{project_id}", response_model=ProjectOut)
async def update_project(
    project_id: uuid.UUID, body: ProjectUpdate, session: AsyncSession = Depends(get_session)
):
    project = await session.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    if body.name is not None:
        project.name = body.name
    if body.description is not None:
        project.description = body.description
    await session.commit()
    await session.refresh(project)
    return _to_out(project, {}, {})


@router.delete("/{project_id}", status_code=204)
async def delete_project(project_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    project = await session.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    await session.delete(project)
    await session.commit()
