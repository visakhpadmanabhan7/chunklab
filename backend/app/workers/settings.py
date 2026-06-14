"""arq worker configuration + a shared pool accessor for enqueuing from the API."""

from arq import create_pool
from arq.connections import RedisSettings

from app.core.config import get_settings
from app.core.logging import get_logger
from app.workers.run_pipeline import parse_file_task, run_pipeline

logger = get_logger(__name__)

REDIS_SETTINGS = RedisSettings.from_dsn(get_settings().REDIS_URL)


async def _startup(ctx) -> None:
    # Warm the embedding model in the worker process.
    from app.core.embedding import get_embedding_model

    get_embedding_model()

    # Self-heal: re-enqueue any files left in a non-terminal parse state
    # (e.g. interrupted by a restart) so they don't get stuck on "uploaded".
    from sqlalchemy import select

    from app.db.models_core import File
    from app.db.session import session_scope

    async with session_scope() as session:
        stuck = (
            await session.execute(
                select(File.id).where(File.status.in_(["uploaded", "parsing"]))
            )
        ).scalars().all()
    for fid in stuck:
        await ctx["redis"].enqueue_job("parse_file_task", str(fid))
    logger.info("Worker started; embeddings warmed; re-enqueued %d stuck file(s)", len(stuck))


async def get_arq_pool():
    return await create_pool(REDIS_SETTINGS)


class WorkerSettings:
    functions = [run_pipeline, parse_file_task]
    redis_settings = REDIS_SETTINGS
    on_startup = _startup
    job_timeout = 60 * 60  # 1h per run
    max_jobs = 4
    keep_result = 60 * 60
