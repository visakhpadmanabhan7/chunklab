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
    from sqlalchemy import select, update

    from app.db.models_core import File, Run
    from app.db.session import session_scope

    async with session_scope() as session:
        stuck = (
            await session.execute(
                select(File.id).where(File.status.in_(["uploaded", "parsing"]))
            )
        ).scalars().all()
        # Self-heal orphaned runs: a run left "running" means a worker was mid-flight
        # and was killed (e.g. OOM). The heavy run job does not auto-retry, so mark
        # these failed instead of leaving zombies the UI polls forever.
        orphaned = (
            await session.execute(
                update(Run)
                .where(Run.status == "running")
                .values(status="failed", error="Worker was interrupted; run did not finish.")
                .returning(Run.id)
            )
        ).scalars().all()
        await session.commit()
    for fid in stuck:
        await ctx["redis"].enqueue_job("parse_file_task", str(fid))
    logger.info(
        "Worker started; embeddings warmed; re-enqueued %d stuck file(s); failed %d orphaned run(s)",
        len(stuck),
        len(orphaned),
    )


async def get_arq_pool():
    return await create_pool(REDIS_SETTINGS)


class WorkerSettings:
    functions = [run_pipeline, parse_file_task]
    redis_settings = REDIS_SETTINGS
    on_startup = _startup
    job_timeout = 60 * 60  # 1h per run
    max_jobs = 4
    keep_result = 60 * 60
    # Do NOT auto-retry: the run pipeline writes results as it goes, so re-running
    # the same run_id from scratch would duplicate rows (unique-key crashes).
    # An interrupted run is healed to "failed" on startup; the user re-runs it.
    max_tries = 1
