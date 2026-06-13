"""Async Redis client + progress pub/sub helpers.

Progress is dual-written for robustness:
  - PUBLISH on channel `run:{run_id}:progress`  → live SSE push
  - HSET   on hash   `run:{run_id}:state`       → snapshot for late joiners
"""

import json
from functools import lru_cache

import redis.asyncio as aioredis

from app.core.config import get_settings


@lru_cache
def get_redis() -> aioredis.Redis:
    settings = get_settings()
    return aioredis.from_url(settings.REDIS_URL, decode_responses=True)


def channel(run_id: str) -> str:
    return f"run:{run_id}:progress"


def state_key(run_id: str) -> str:
    return f"run:{run_id}:state"


async def publish_progress(run_id: str, event: dict) -> None:
    r = get_redis()
    payload = json.dumps(event)
    await r.publish(channel(run_id), payload)
    # Keep a per-field snapshot keyed by a stable id so reconnects see current state.
    field = event.get("key") or event.get("type", "event")
    await r.hset(state_key(run_id), field, payload)
    await r.expire(state_key(run_id), 60 * 60 * 24)


async def get_state(run_id: str) -> list[dict]:
    r = get_redis()
    raw = await r.hgetall(state_key(run_id))
    return [json.loads(v) for v in raw.values()]
