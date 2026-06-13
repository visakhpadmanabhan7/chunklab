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
    logger.info("Worker started; embedding model warmed")


async def get_arq_pool():
    return await create_pool(REDIS_SETTINGS)


class WorkerSettings:
    functions = [run_pipeline, parse_file_task]
    redis_settings = REDIS_SETTINGS
    on_startup = _startup
    job_timeout = 60 * 60  # 1h per run
    max_jobs = 4
    keep_result = 60 * 60
