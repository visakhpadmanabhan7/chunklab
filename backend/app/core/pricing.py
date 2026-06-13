"""Cost model.

Local embeddings have no real API cost, so embedding cost is a *notional*
reference rate (configurable) that makes chunking combinations dollar-comparable.
Groq judge/chat cost is computed from real token usage (response.usage).
"""

from app.core.config import get_settings


def embedding_cost(total_tokens: int) -> float:
    settings = get_settings()
    return round(total_tokens / 1000 * settings.EMBED_COST_PER_1K, 6)


def groq_cost(prompt_tokens: int, completion_tokens: int) -> float:
    settings = get_settings()
    cost = (
        prompt_tokens / 1_000_000 * settings.GROQ_INPUT_COST_PER_M
        + completion_tokens / 1_000_000 * settings.GROQ_OUTPUT_COST_PER_M
    )
    return round(cost, 6)
