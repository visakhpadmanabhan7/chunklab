"""Chunking strategy interface and shared helpers."""

from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@dataclass
class Chunk:
    index: int
    content: str
    start: int = 0  # char offset in the source document (for gold-span overlap)
    end: int = 0


@runtime_checkable
class ChunkingStrategy(Protocol):
    name: str

    def split(self, text: str, params: dict) -> list[str]:
        """Split text into raw string pieces."""
        ...

    def label(self, params: dict) -> str:
        """A short human-readable label, e.g. 'sentence·512/20'."""
        ...


def assemble(text: str, pieces: list[str]) -> list[Chunk]:
    """Wrap raw pieces into Chunks, computing char offsets against the source.

    Offsets are best-effort: each piece is located sequentially so overlapping
    chunks still resolve to plausible spans. Pieces that can't be located
    (e.g. whitespace-normalized) fall back to (0, 0).
    """
    chunks: list[Chunk] = []
    cursor = 0
    for i, piece in enumerate(p for p in pieces if p and p.strip()):
        start = text.find(piece, cursor)
        if start == -1:
            start = text.find(piece)  # retry from the beginning
        if start == -1:
            start, end = 0, 0
        else:
            end = start + len(piece)
            cursor = start + 1  # allow overlap on the next search
        chunks.append(Chunk(index=i, content=piece, start=max(start, 0), end=max(end, 0)))
    return chunks
