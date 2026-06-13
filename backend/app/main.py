from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Importing the package registers all chunking strategies.
import app.services.chunking  # noqa: F401
from app.api.routers import (
    analytics,
    chat,
    files,
    progress,
    projects,
    results,
    runs,
)
from app.core.config import get_settings
from app.core.logging import configure_logging, get_logger
from app.db.setup_db import init_db
from app.workers.settings import get_arq_pool

logger = get_logger(__name__)
settings = get_settings()

API_PREFIX = "/api/v1"


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()
    await init_db()
    app.state.arq = await get_arq_pool()
    logger.info("chunklab API ready")
    yield
    await app.state.arq.close()


app = FastAPI(title="chunklab API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for r in (projects, files, runs, progress, results, analytics, chat):
    app.include_router(r.router, prefix=API_PREFIX)


@app.get("/health")
async def health():
    return {"status": "ok"}
