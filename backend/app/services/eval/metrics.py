"""Computed retrieval metrics.

Ground truth = the gold passage a QA pair was generated from. A retrieved chunk
counts as relevant when it comes from the same file AND its text substantially
overlaps the gold passage (word-set overlap >= threshold). With one gold passage
per question, recall/MRR/nDCG use a single relevant target.
"""

import math
import re
import uuid
from dataclasses import dataclass

_WORD_RE = re.compile(r"\w+")
RELEVANCE_THRESHOLD = 0.5


def _words(text: str) -> set[str]:
    return set(_WORD_RE.findall(text.lower()))


def is_relevant(chunk_text: str, gold_text: str) -> bool:
    gold = _words(gold_text)
    if len(gold) < 5:
        return False
    chunk = _words(chunk_text)
    if not chunk:
        return False
    overlap = len(gold & chunk) / len(gold)
    return overlap >= RELEVANCE_THRESHOLD


@dataclass
class QueryMetrics:
    precision_at_k: float
    recall_at_k: float
    mrr: float
    ndcg_at_k: float
    f2: float


def compute_for_query(
    retrieved: list[tuple[uuid.UUID, str, uuid.UUID]],  # (chunk_id, content, file_id)
    gold_text: str,
    gold_file_id: uuid.UUID,
    k: int,
) -> QueryMetrics:
    flags = [
        bool(fid == gold_file_id and is_relevant(content, gold_text))
        for (_cid, content, fid) in retrieved[:k]
    ]
    num_relevant = sum(flags)
    denom = max(k, 1)

    precision = num_relevant / denom
    recall = 1.0 if num_relevant > 0 else 0.0  # single gold passage

    mrr = 0.0
    for rank, flag in enumerate(flags, start=1):
        if flag:
            mrr = 1.0 / rank
            break

    dcg = sum((1.0 / math.log2(i + 2)) for i, flag in enumerate(flags) if flag)
    # ideal DCG = all relevant hits ranked first (cap at k); guarantees nDCG <= 1
    ideal_hits = min(num_relevant, denom)
    idcg = sum(1.0 / math.log2(i + 2) for i in range(ideal_hits))
    ndcg = dcg / idcg if idcg else 0.0

    f2 = (5 * precision * recall) / (4 * precision + recall) if (precision + recall) else 0.0

    return QueryMetrics(
        precision_at_k=round(precision, 4),
        recall_at_k=round(recall, 4),
        mrr=round(mrr, 4),
        ndcg_at_k=round(ndcg, 4),
        f2=round(f2, 4),
    )


def macro_average(per_query: list[QueryMetrics]) -> QueryMetrics:
    if not per_query:
        return QueryMetrics(0.0, 0.0, 0.0, 0.0, 0.0)
    n = len(per_query)
    return QueryMetrics(
        precision_at_k=round(sum(m.precision_at_k for m in per_query) / n, 4),
        recall_at_k=round(sum(m.recall_at_k for m in per_query) / n, 4),
        mrr=round(sum(m.mrr for m in per_query) / n, 4),
        ndcg_at_k=round(sum(m.ndcg_at_k for m in per_query) / n, 4),
        f2=round(sum(m.f2 for m in per_query) / n, 4),
    )
