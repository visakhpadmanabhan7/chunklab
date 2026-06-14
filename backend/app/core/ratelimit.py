"""Rate limiting (slowapi, in-memory per-process).

A generous global default protects the API; expensive endpoints (chat, run
creation, uploads) get stricter per-route limits via @limiter.limit(...).
"""

from slowapi import Limiter
from slowapi.util import get_remote_address

# In-memory storage is fine for a single backend instance. For multi-instance,
# pass storage_uri="redis://..." (requires the coredis extra).
limiter = Limiter(key_func=get_remote_address, default_limits=["600/minute"])
