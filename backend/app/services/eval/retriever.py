"""Vector retrieval over a single combination's chunks (pgvector cosine)."""

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models_results import Chunk


@dataclass
class RetrievedChunk:
    id: uuid.UUID
    file_id: uuid.UUID
    content: str
    relevance: float  # cosine similarity 0..1


async def retrieve(
    session: AsyncSession,
    combination_id: uuid.UUID,
    query_vector: list[float],
    k: int,
) -> list[RetrievedChunk]:
    distance = Chunk.embedding.cosine_distance(query_vector)
    stmt = (
        select(Chunk.id, Chunk.file_id, Chunk.content, distance.label("distance"))
        .where(Chunk.combination_id == combination_id)
        .order_by(distance)
        .limit(k)
    )
    rows = (await session.execute(stmt)).all()
    return [
        RetrievedChunk(
            id=row.id,
            file_id=row.file_id,
            content=row.content,
            relevance=round(max(0.0, 1.0 - float(row.distance)), 4),
        )
        for row in rows
    ]
