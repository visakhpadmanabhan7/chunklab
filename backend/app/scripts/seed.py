"""Seed a sample project + document so the app is usable immediately.

Usage: python -m app.scripts.seed
"""

import asyncio
import uuid
from pathlib import Path

from app.core.config import get_settings
from app.db.models_core import File, ParsedDocument, Project
from app.db.session import session_scope
from app.db.setup_db import init_db

SAMPLE_TEXT = """# Retrieval-Augmented Generation and Chunking

Retrieval-augmented generation (RAG) combines a large language model with an
external knowledge store. Documents are split into chunks, embedded into vectors,
and indexed in a vector database. At query time, the most similar chunks are
retrieved and supplied to the model as context.

## Why chunking matters

The way a document is split has a large effect on retrieval quality. Chunks that
are too large dilute the embedding with unrelated content, lowering precision.
Chunks that are too small fragment ideas and hurt recall because a single chunk
may not contain a complete answer. The goal is to keep semantically coherent
units together while staying within a useful token budget.

## Common strategies

Fixed-size character chunking splits text every N characters with optional
overlap. It is simple and fast but ignores sentence and paragraph boundaries.
Recursive character splitting tries a hierarchy of separators (paragraphs, then
sentences, then words) to avoid cutting mid-sentence. Sentence-based splitting
packs whole sentences up to a token target. Token-based chunking measures size in
model tokens directly. Semantic chunking embeds sentences and starts a new chunk
where the topic shifts, detected by a drop in embedding similarity.

## Evaluating retrieval

To compare strategies fairly, generate a fixed set of question-answer pairs from
the corpus and measure how well each strategy retrieves the supporting context.
Useful metrics include precision@k, recall@k, mean reciprocal rank, and nDCG,
alongside an LLM judge scoring relevance and faithfulness. Cost and token usage
matter too: a strategy that is slightly more accurate but far more expensive may
not be worth it.
"""


async def main() -> None:
    settings = get_settings()
    await init_db()
    async with session_scope() as session:
        project = Project(name="Sample: RAG & Chunking", description="Seeded demo project")
        session.add(project)
        await session.flush()

        file_id = uuid.uuid4()
        dest_dir = Path(settings.STORAGE_DIR) / str(project.id)
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / f"{file_id}_rag_chunking.md"
        dest.write_text(SAMPLE_TEXT, encoding="utf-8")

        file = File(
            id=file_id,
            project_id=project.id,
            filename="rag_chunking.md",
            storage_path=str(dest),
            mime_type="text/markdown",
            size_bytes=len(SAMPLE_TEXT),
            status="parsed",
            parser_used="fallback",
        )
        session.add(file)
        session.add(
            ParsedDocument(
                file_id=file_id,
                clean_text=SAMPLE_TEXT,
                char_count=len(SAMPLE_TEXT),
                page_count=None,
            )
        )
        await session.commit()
        print(f"Seeded project {project.id} with file {file_id}")


if __name__ == "__main__":
    asyncio.run(main())
