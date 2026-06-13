import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi import File as UploadField
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_arq, get_session
from app.core.config import get_settings
from app.db.models_core import File, ParsedDocument, Project
from app.schemas.file import FileOut, ParsedDocumentOut

router = APIRouter(tags=["files"])
settings = get_settings()


@router.post("/projects/{project_id}/files", response_model=FileOut, status_code=201)
async def upload_file(
    project_id: uuid.UUID,
    upload: UploadFile = UploadField(...),
    session: AsyncSession = Depends(get_session),
    arq=Depends(get_arq),
):
    project = await session.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    file_id = uuid.uuid4()
    dest_dir = Path(settings.STORAGE_DIR) / str(project_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{file_id}_{upload.filename}"
    data = await upload.read()
    dest.write_bytes(data)

    file = File(
        id=file_id,
        project_id=project_id,
        filename=upload.filename or str(file_id),
        storage_path=str(dest),
        mime_type=upload.content_type,
        size_bytes=len(data),
        status="uploaded",
    )
    session.add(file)
    await session.commit()
    await session.refresh(file)

    await arq.enqueue_job("parse_file_task", str(file.id))
    return FileOut.model_validate(file)


@router.get("/projects/{project_id}/files", response_model=list[FileOut])
async def list_files(project_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    rows = await session.execute(
        select(File).where(File.project_id == project_id).order_by(File.created_at.desc())
    )
    return [FileOut.model_validate(f) for f in rows.scalars().all()]


@router.get("/files/{file_id}", response_model=FileOut)
async def get_file(file_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    file = await session.get(File, file_id)
    if not file:
        raise HTTPException(404, "File not found")
    return FileOut.model_validate(file)


@router.get("/files/{file_id}/parsed", response_model=ParsedDocumentOut)
async def get_parsed(file_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    doc = (
        await session.execute(
            select(ParsedDocument).where(ParsedDocument.file_id == file_id)
        )
    ).scalar_one_or_none()
    if not doc:
        raise HTTPException(404, "File not parsed yet")
    return ParsedDocumentOut.model_validate(doc)


@router.delete("/files/{file_id}", status_code=204)
async def delete_file(file_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    file = await session.get(File, file_id)
    if not file:
        raise HTTPException(404, "File not found")
    try:
        Path(file.storage_path).unlink(missing_ok=True)
    except OSError:
        pass
    await session.delete(file)
    await session.commit()
