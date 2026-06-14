import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.core.config import get_settings
from app.core.logging import configure_logging, get_logger
from app.core.ratelimit import limiter
from app.db.setup_db import init_db
from app.workers.settings import get_arq_pool

# Importing the package registers all chunking strategies.
import app.services.chunking  # noqa: F401
from app.api.routers import (
    analytics,
    chat,
    files,
    logs,
    progress,
    projects,
    results,
    runs,
)

logger = get_logger(__name__)
access_log = get_logger("access")
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

# ---- rate limiting ----
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

# ---- CORS ----
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---- request logging (info 2xx/3xx · warning 4xx · error 5xx) ----
@app.middleware("http")
async def log_requests(request: Request, call_next):
    if request.url.path == "/health":
        return await call_next(request)
    start = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        dur = (time.perf_counter() - start) * 1000
        access_log.exception("%s %s -> 500 (%.0fms)", request.method, request.url.path, dur)
        raise
    dur = (time.perf_counter() - start) * 1000
    msg = "%s %s -> %d (%.0fms)"
    args = (request.method, request.url.path, response.status_code, dur)
    if response.status_code >= 500:
        access_log.error(msg, *args)
    elif response.status_code >= 400:
        access_log.warning(msg, *args)
    else:
        access_log.info(msg, *args)
    return response


for r in (projects, files, runs, progress, results, analytics, chat, logs):
    app.include_router(r.router, prefix=API_PREFIX)


@app.get("/health")
async def health():
    return {"status": "ok"}
