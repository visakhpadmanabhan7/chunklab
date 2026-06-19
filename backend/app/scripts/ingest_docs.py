"""Re-ingest the product-assistant knowledge base (force refresh).

Usage:
    docker compose exec backend python -m app.scripts.ingest_docs
"""

import asyncio

from app.db.session import session_scope
from app.db.setup_db import init_db
from app.services.docs.knowledge import ingest_knowledge


async def main() -> None:
    await init_db()
    async with session_scope() as session:
        n = await ingest_knowledge(session, force=True)
        print(f"ingested {n} knowledge chunks")


if __name__ == "__main__":
    asyncio.run(main())
