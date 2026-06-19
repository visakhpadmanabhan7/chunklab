"""Rate limiting (slowapi).

A generous global default protects the API; expensive endpoints (chat, run
creation, uploads) get stricter per-route limits via @limiter.limit(...).

Counters are stored in Redis so limits are shared/consistent across multiple
backend instances. Falls back to in-memory if Redis is unavailable.
"""

from slowapi import Limiter
from slowapi.util import get_remote_address

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)
_settings = get_settings()

try:
    limiter = Limiter(
        key_func=get_remote_address,
        default_limits=["600/minute"],
        storage_uri=_settings.REDIS_URL,
    )
except Exception as exc:  # pragma: no cover - fallback if redis storage init fails
    logger.warning("Redis rate-limit storage unavailable (%s); using in-memory", exc)
    limiter = Limiter(key_func=get_remote_address, default_limits=["600/minute"])
