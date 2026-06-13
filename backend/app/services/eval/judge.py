"""LLM-as-judge (Groq) scoring of retrieval quality for one question."""

from dataclasses import dataclass

from app.core.jsonutil import parse_json
from app.core.llm import get_llm
from app.core.logging import get_logger
from app.prompts.prompt_texts import JUDGE_PROMPT

logger = get_logger(__name__)


@dataclass
class JudgeResult:
    relevance: float = 0.0
    faithfulness: float = 0.0
    context_precision: float = 0.0
    context_recall: float = 0.0
    feedback: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0


def _clamp(v) -> float:
    try:
        return max(0.0, min(1.0, float(v)))
    except (TypeError, ValueError):
        return 0.0


async def judge(question: str, reference_answer: str, contexts: list[str]) -> JudgeResult:
    numbered = "\n\n".join(f"[{i + 1}] {c}" for i, c in enumerate(contexts)) or "(none)"
    user_input = (
        f"QUESTION:\n{question}\n\n"
        f"REFERENCE ANSWER:\n{reference_answer}\n\n"
        f"CONTEXT:\n{numbered}"
    )
    llm = get_llm()
    try:
        result = await llm.extract(JUDGE_PROMPT, user_input)
        data = parse_json(result.content)
    except Exception as exc:  # pragma: no cover - resilience
        logger.warning("Judge call failed: %s", exc)
        return JudgeResult()

    if not isinstance(data, dict):
        return JudgeResult()

    return JudgeResult(
        relevance=_clamp(data.get("relevance")),
        faithfulness=_clamp(data.get("faithfulness")),
        context_precision=_clamp(data.get("context_precision")),
        context_recall=_clamp(data.get("context_recall")),
        feedback=str(data.get("feedback", ""))[:500],
        prompt_tokens=result.usage.prompt_tokens,
        completion_tokens=result.usage.completion_tokens,
    )
