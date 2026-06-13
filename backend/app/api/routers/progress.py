import asyncio
import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from app.api.deps import get_session
from app.core.redis import channel, get_redis, get_state
from app.db.models_core import Run

router = APIRouter(tags=["progress"])

_TERMINAL = {"completed", "failed", "canceled"}


@router.get("/runs/{run_id}/progress")
async def progress_snapshot(run_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    run = await session.get(Run, run_id)
    if not run:
        raise HTTPException(404, "Run not found")
    events = await get_state(str(run_id))
    return {
        "run_id": str(run_id),
        "status": run.status,
        "progress": run.progress,
        "events": events,
    }


@router.get("/runs/{run_id}/progress/stream")
async def progress_stream(run_id: uuid.UUID, request: Request):
    run_id_str = str(run_id)

    async def event_gen():
        # 1) replay current snapshot so a late joiner sees full state
        for ev in await get_state(run_id_str):
            yield {"data": json.dumps(ev)}

        # 2) live updates
        redis = get_redis()
        pubsub = redis.pubsub()
        await pubsub.subscribe(channel(run_id_str))
        try:
            while True:
                if await request.is_disconnected():
                    break
                msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if msg is None:
                    yield {"event": "ping", "data": "{}"}
                    continue
                data = msg["data"]
                yield {"data": data}
                try:
                    parsed = json.loads(data)
                    if parsed.get("type") == "run" and parsed.get("status") in _TERMINAL:
                        break
                except json.JSONDecodeError:
                    pass
                await asyncio.sleep(0)
        finally:
            await pubsub.unsubscribe(channel(run_id_str))
            await pubsub.aclose()

    return EventSourceResponse(event_gen())
