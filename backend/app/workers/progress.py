"""Progress publishing for run jobs.

Each event is pushed to Redis (pub/sub for live SSE + a snapshot hash for late
joiners) and the aggregate is denormalized onto the DB rows so REST polling and
post-hoc reads stay correct.
"""

import uuid

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.redis import publish_progress
from app.db.models_core import Run, RunCombination

_log_seq = 0


async def emit_run(run_id: str, status: str, pct: float) -> None:
    await publish_progress(
        run_id, {"type": "run", "key": "run", "status": status, "pct": round(pct, 4)}
    )


async def emit_combo(run_id: str, combo_id: str, label: str, status: str, pct: float) -> None:
    await publish_progress(
        run_id,
        {
            "type": "combo",
            "key": f"combo:{combo_id}",
            "comboId": combo_id,
            "label": label,
            "status": status,
            "pct": round(pct, 4),
        },
    )


async def emit_file(
    run_id: str, combo_id: str, file_id: str, stage: str, pct: float, status: str = "running"
) -> None:
    await publish_progress(
        run_id,
        {
            "type": "file",
            "key": f"file:{combo_id}:{file_id}",
            "comboId": combo_id,
            "fileId": file_id,
            "stage": stage,
            "status": status,
            "pct": round(pct, 4),
        },
    )


async def emit_log(run_id: str, message: str, level: str = "info") -> None:
    global _log_seq
    _log_seq += 1
    await publish_progress(
        run_id,
        {"type": "log", "key": f"log:{_log_seq}", "level": level, "message": message},
    )


async def set_run_status(
    session: AsyncSession, run_id: uuid.UUID, status: str, progress: float | None = None
) -> None:
    values: dict = {"status": status}
    if progress is not None:
        values["progress"] = progress
    await session.execute(update(Run).where(Run.id == run_id).values(**values))
    await session.commit()


async def set_combo_status(
    session: AsyncSession, combo_id: uuid.UUID, status: str, progress: float | None = None
) -> None:
    values: dict = {"status": status}
    if progress is not None:
        values["progress"] = progress
    await session.execute(
        update(RunCombination).where(RunCombination.id == combo_id).values(**values)
    )
    await session.commit()
