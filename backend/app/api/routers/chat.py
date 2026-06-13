from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_session
from app.schemas.chat import ChatRequest
from app.services.chat.chat_service import stream_answer
from app.services.chat.context_builder import build_context

router = APIRouter(tags=["chat"])


@router.post("/chat/stream")
async def chat_stream(body: ChatRequest, session: AsyncSession = Depends(get_session)):
    if body.scope == "run" and not body.run_id:
        raise HTTPException(400, "run_id required for scope=run")
    if body.scope == "compare" and not (body.run_ids and len(body.run_ids) >= 2):
        raise HTTPException(400, "two run_ids required for scope=compare")
    if body.scope == "project" and not body.project_id:
        raise HTTPException(400, "project_id required for scope=project")

    context = await build_context(
        session,
        scope=body.scope,
        query=body.message,
        project_id=body.project_id,
        run_id=body.run_id,
        run_ids=body.run_ids,
    )
    history = [m.model_dump() for m in body.history]

    async def token_stream():
        async for token in stream_answer(context, body.message, history):
            yield token

    return StreamingResponse(token_stream(), media_type="text/plain; charset=utf-8")
