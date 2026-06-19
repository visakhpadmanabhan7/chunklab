"""Idempotent database bootstrap, run on app/worker startup.

Creates the pgvector extension, both schemas, all tables, and the HNSW vector
index. Safe to call repeatedly.
"""

from sqlalchemy import text

from app.core.logging import get_logger

# Import models so their tables register on the shared metadata.
from app.db import (
    models_core,  # noqa: F401
    models_results,  # noqa: F401
)
from app.db.base import Base
from app.db.engine import engine

logger = get_logger(__name__)


async def init_db() -> None:
    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.execute(text("CREATE SCHEMA IF NOT EXISTS core"))
        await conn.execute(text("CREATE SCHEMA IF NOT EXISTS results"))
        # One metadata holds both schemas, so create_all sorts cross-schema FKs.
        await conn.run_sync(Base.metadata.create_all)
        # HNSW cosine index for vector search (no training, supports inserts)
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw "
                "ON results.chunks USING hnsw (embedding vector_cosine_ops) "
                "WITH (m = 16, ef_construction = 64)"
            )
        )
        # Same HNSW cosine index for the product-assistant doc embeddings.
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_doc_chunks_embedding_hnsw "
                "ON results.doc_chunks USING hnsw (embedding vector_cosine_ops) "
                "WITH (m = 16, ef_construction = 64)"
            )
        )
    logger.info("Database initialized (schemas core/results, pgvector ready)")
