"""Semantic chunking: split where the topic shifts.

Sentences are embedded with the light embedding model; consecutive cosine
distances above a percentile threshold mark breakpoints. Self-contained (no
langchain-experimental dependency) and deterministic.
"""

import re

from app.services.chunking.registry import register

_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")


def _split_sentences(text: str) -> list[str]:
    parts = [s.strip() for s in _SENTENCE_RE.split(text) if s.strip()]
    return parts


class SemanticStrategy:
    name = "semantic"

    def split(self, text: str, params: dict) -> list[str]:
        import numpy as np

        from app.core.embedding import embed_texts

        percentile = float(params.get("breakpoint_percentile", params.get("threshold", 95)))
        # `threshold` may be given as a 0..1 fraction; normalize to a percentile.
        if percentile <= 1.0:
            percentile *= 100.0

        sentences = _split_sentences(text)
        if len(sentences) <= 1:
            return sentences or [text]

        embeddings = np.array(embed_texts(sentences))
        # fastembed returns L2-normalized vectors → cosine distance = 1 - dot.
        sims = np.sum(embeddings[:-1] * embeddings[1:], axis=1)
        distances = 1.0 - sims
        if distances.size == 0:
            return [" ".join(sentences)]

        cutoff = float(np.percentile(distances, percentile))
        breakpoints = [i for i, d in enumerate(distances) if d > cutoff]

        chunks: list[str] = []
        start = 0
        for bp in breakpoints:
            chunks.append(" ".join(sentences[start : bp + 1]))
            start = bp + 1
        if start < len(sentences):
            chunks.append(" ".join(sentences[start:]))
        return [c for c in chunks if c.strip()]

    def label(self, params: dict) -> str:
        pct = params.get("breakpoint_percentile", params.get("threshold", 95))
        return f"semantic·pct{pct}"


register(SemanticStrategy())
