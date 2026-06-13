"""Auto-generate a QA evaluation set from a document via Groq.

Passages are sampled evenly across the document; each yields one grounded
question + reference answer. The passage span is kept as gold context for the
computed retrieval metrics.
"""

from dataclasses import dataclass

from app.core.jsonutil import parse_json
from app.core.llm import get_llm
from app.core.logging import get_logger
from app.prompts.prompt_texts import QA_GENERATOR_PROMPT

logger = get_logger(__name__)


@dataclass
class GeneratedQA:
    question: str
    reference_answer: str
    source_chunk_text: str
    start: int
    end: int
    prompt_tokens: int = 0
    completion_tokens: int = 0


def _sample_passages(text: str, n: int, window: int = 900) -> list[tuple[int, str]]:
    """Return up to n (offset, passage) windows spread across the document."""
    text = text.strip()
    if not text:
        return []
    if len(text) <= window:
        return [(0, text)]
    n = max(1, n)
    # evenly spaced, non-overlapping-ish window starts
    span = len(text) - window
    step = max(span // n, 1)
    passages: list[tuple[int, str]] = []
    for i in range(n):
        start = min(i * step, span)
        passages.append((start, text[start : start + window]))
    return passages


async def generate_qa_pairs(text: str, n: int) -> list[GeneratedQA]:
    llm = get_llm()
    out: list[GeneratedQA] = []
    for start, passage in _sample_passages(text, n):
        try:
            result = await llm.extract(QA_GENERATOR_PROMPT, passage)
            data = parse_json(result.content)
        except Exception as exc:  # pragma: no cover - network/parse resilience
            logger.warning("QA generation failed for a passage: %s", exc)
            continue
        if not isinstance(data, dict):
            continue
        question = (data.get("question") or "").strip()
        answer = (data.get("reference_answer") or "").strip()
        if not question or not answer:
            continue
        out.append(
            GeneratedQA(
                question=question,
                reference_answer=answer,
                source_chunk_text=passage,
                start=start,
                end=start + len(passage),
                prompt_tokens=result.usage.prompt_tokens,
                completion_tokens=result.usage.completion_tokens,
            )
        )
    return out
