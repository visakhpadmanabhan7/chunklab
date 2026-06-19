"""Product-assistant knowledge base.

chunklab dogfoods its own RAG pipeline to answer questions about itself. The
curated markdown under ``app/knowledge/`` is split by heading into sections,
embedded with the SAME FastEmbed model used for experiments, and stored in
``results.doc_chunks``. At chat time (scope="about") the user's question is
embedded and the most similar sections are retrieved by pgvector cosine
similarity and handed to the LLM as grounded context.

Ingestion is idempotent: a hash of the corpus (``corpus_version``) is stored on
every row, so startup re-ingests only when the docs actually change.
"""

import asyncio
import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.embedding import count_tokens, embed_query, embed_texts
from app.core.logging import get_logger
from app.db.models_results import DocChunk

logger = get_logger(__name__)

# app/services/docs/knowledge.py -> parents[2] == app/, so app/knowledge/
KNOWLEDGE_DIR = Path(__file__).resolve().parents[2] / "knowledge"
MAX_CHARS = 1400  # window long sections so each retrieved block stays focused

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")

ABOUT_PREAMBLE = (
    "chunklab is a full-stack tool for evaluating and comparing text-chunking "
    "strategies for retrieval-augmented generation (RAG). A user creates a "
    "project, uploads documents, picks a combinatorial matrix of chunking "
    "strategies, and launches a run: each file is parsed, chunked per "
    "combination, embedded, token-counted, cost-estimated, stored in pgvector, "
    "then scored for retrieval accuracy by an LLM-as-judge plus computed IR "
    "metrics over an auto-generated QA set. Results drive analytics and a chatbot."
)


@dataclass
class DocSection:
    source: str
    title: str
    section: str
    content: str


@dataclass
class RetrievedDoc:
    source: str
    section: str
    content: str
    relevance: float  # cosine similarity 0..1


def _first_heading(text: str) -> str | None:
    for line in text.splitlines():
        m = _HEADING_RE.match(line)
        if m:
            return m.group(2).strip()
    return None


def _split_markdown(text: str) -> list[tuple[str, str]]:
    """Split a markdown doc into (heading, body) sections on ATX headings."""
    sections: list[tuple[str, str]] = []
    heading = "Overview"
    buf: list[str] = []
    for line in text.splitlines():
        m = _HEADING_RE.match(line)
        if m:
            if buf:
                sections.append((heading, "\n".join(buf).strip()))
                buf = []
            heading = m.group(2).strip()
        else:
            buf.append(line)
    if buf:
        sections.append((heading, "\n".join(buf).strip()))
    return sections


def _windows(text: str, size: int) -> list[str]:
    """Pack paragraphs into ~size-char windows; hard-wrap any oversized one."""
    if len(text) <= size:
        return [text]
    paras = re.split(r"\n\s*\n", text)
    packed: list[str] = []
    cur = ""
    for p in paras:
        if cur and len(cur) + len(p) + 2 > size:
            packed.append(cur.strip())
            cur = p
        else:
            cur = f"{cur}\n\n{p}" if cur else p
    if cur.strip():
        packed.append(cur.strip())
    out: list[str] = []
    for w in packed:
        if len(w) <= size * 1.5:
            out.append(w)
        else:
            out.extend(w[i : i + size] for i in range(0, len(w), size))
    return [w for w in out if w.strip()]


def load_sections() -> list[DocSection]:
    """Load + chunk every markdown file in the knowledge dir."""
    sections: list[DocSection] = []
    if not KNOWLEDGE_DIR.is_dir():
        logger.warning("knowledge dir not found: %s", KNOWLEDGE_DIR)
        return sections
    for path in sorted(KNOWLEDGE_DIR.glob("*.md")):
        raw = path.read_text(encoding="utf-8")
        title = _first_heading(raw) or path.stem
        for heading, body in _split_markdown(raw):
            if not body.strip():
                continue
            for window in _windows(body.strip(), MAX_CHARS):
                sections.append(
                    DocSection(source=path.name, title=title, section=heading, content=window)
                )
    return sections


def corpus_hash() -> str:
    """Stable short hash of the whole knowledge corpus (name + bytes)."""
    h = hashlib.sha256()
    if KNOWLEDGE_DIR.is_dir():
        for path in sorted(KNOWLEDGE_DIR.glob("*.md")):
            h.update(path.name.encode())
            h.update(path.read_bytes())
    return h.hexdigest()[:16]


def _embed_sections(sections: list[DocSection]) -> tuple[list[list[float]], list[int]]:
    # Heading terms are part of the embedded text so topical queries match well.
    embed_input = [f"{s.title} › {s.section}\n{s.content}" for s in sections]
    vectors = embed_texts(embed_input)
    tokens = [count_tokens(s.content) for s in sections]
    return vectors, tokens


async def ingest_knowledge(session: AsyncSession, *, force: bool = False) -> int:
    """Embed + store the knowledge base. Idempotent: skips when unchanged.

    Returns the number of chunks written (0 if skipped because up to date).
    """
    version = corpus_hash()
    if not force:
        existing = (
            await session.execute(select(DocChunk.corpus_version).limit(1))
        ).scalar_one_or_none()
        if existing == version and version:
            return 0

    sections = load_sections()
    if not sections:
        return 0

    vectors, tokens = await asyncio.to_thread(_embed_sections, sections)

    await session.execute(delete(DocChunk))
    for sec, vec, tok in zip(sections, vectors, tokens):
        session.add(
            DocChunk(
                source=sec.source,
                title=sec.title,
                section=sec.section,
                content=sec.content,
                token_count=tok,
                corpus_version=version,
                embedding=vec,
            )
        )
    await session.commit()
    logger.info("ingested %d knowledge chunks (corpus %s)", len(sections), version)
    return len(sections)


async def retrieve_docs(session: AsyncSession, query: str, k: int = 10) -> list[RetrievedDoc]:
    """Top-k knowledge sections most similar to the query (pgvector cosine)."""
    qvec = await asyncio.to_thread(embed_query, query)
    distance = DocChunk.embedding.cosine_distance(qvec)
    stmt = (
        select(DocChunk.source, DocChunk.section, DocChunk.content, distance.label("distance"))
        .order_by(distance)
        .limit(k)
    )
    rows = (await session.execute(stmt)).all()
    return [
        RetrievedDoc(
            source=row.source,
            section=row.section,
            content=row.content,
            relevance=round(max(0.0, 1.0 - float(row.distance)), 4),
        )
        for row in rows
    ]


async def build_about_context(session: AsyncSession, query: str, k: int = 10) -> str:
    """Assemble grounded context for the product assistant.

    Always includes a short product preamble; self-heals by ingesting on first
    use if the table is empty (e.g. startup ingest was skipped).
    """
    docs = await retrieve_docs(session, query, k)
    if not docs:
        try:
            await ingest_knowledge(session, force=True)
            docs = await retrieve_docs(session, query, k)
        except Exception as exc:  # pragma: no cover - resilience
            logger.warning("lazy knowledge ingest failed: %s", exc)
    if not docs:
        return ABOUT_PREAMBLE
    blocks = [f"[{d.source} › {d.section}] (match {d.relevance})\n{d.content}" for d in docs]
    return (
        f"{ABOUT_PREAMBLE}\n\n## Retrieved documentation sections\n\n"
        + "\n\n---\n\n".join(blocks)
    )


async def ensure_knowledge_ingested() -> int:
    """Startup hook: ingest the knowledge base if missing/changed."""
    from app.db.session import session_scope

    async with session_scope() as session:
        return await ingest_knowledge(session)
