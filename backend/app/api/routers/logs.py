"""Client log ingest — UI actions/clicks/errors land in the backend log stream
so they show up in `docker compose logs backend` for debugging."""

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.core.logging import get_logger

router = APIRouter(tags=["logs"])
logger = get_logger("client")


class ClientEvent(BaseModel):
    level: str = "info"  # debug | info | warn | error
    event: str
    detail: dict | None = None
    path: str | None = None


class ClientBatch(BaseModel):
    events: list[ClientEvent]


@router.post("/logs")
async def ingest_logs(batch: ClientBatch, request: Request):
    ip = request.client.host if request.client else "?"
    for e in batch.events:
        parts = [f"[ui {ip}]", e.event]
        if e.path:
            parts.append(f"@ {e.path}")
        if e.detail:
            parts.append(f"| {e.detail}")
        msg = " ".join(parts)
        lvl = e.level.lower()
        if lvl == "error":
            logger.error(msg)
        elif lvl in ("warn", "warning"):
            logger.warning(msg)
        elif lvl == "debug":
            logger.debug(msg)
        else:
            logger.info(msg)
    return {"ok": True, "received": len(batch.events)}
