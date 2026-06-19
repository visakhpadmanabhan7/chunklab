"""Cost model.

Local embeddings have no real API cost, so embedding cost is a *notional*
reference rate (configurable) that keeps chunking combinations dollar-comparable.
LLM (QA-gen / judge / chat) cost is computed from real token usage at
per-provider/per-model rates.
"""

from app.core.config import get_settings

# Approximate public list prices in USD per 1M tokens: (input, output).
# Used for the real LLM cost; unknown models fall back to the provider default.
_PRICING: dict[tuple[str, str], tuple[float, float]] = {
    ("groq", "llama-3.1-8b-instant"): (0.05, 0.08),
    ("groq", "llama-3.3-70b-versatile"): (0.59, 0.79),
    ("openai", "gpt-4o-mini"): (0.15, 0.60),
    ("openai", "gpt-4o"): (2.50, 10.00),
    ("openai", "gpt-4.1-mini"): (0.40, 1.60),
    ("anthropic", "claude-3-5-haiku-latest"): (0.80, 4.00),
    ("anthropic", "claude-3-5-sonnet-latest"): (3.00, 15.00),
}
_PROVIDER_DEFAULT: dict[str, tuple[float, float]] = {
    "groq": (0.59, 0.79),
    "openai": (0.15, 0.60),
    "anthropic": (0.80, 4.00),
}


def embedding_cost(total_tokens: int) -> float:
    settings = get_settings()
    return round(total_tokens / 1000 * settings.EMBED_COST_PER_1K, 6)


def llm_cost(provider: str, model: str, prompt_tokens: int, completion_tokens: int) -> float:
    """Real LLM cost from token usage at the provider/model's rate."""
    settings = get_settings()
    rate = (
        _PRICING.get((provider, model))
        or _PROVIDER_DEFAULT.get(provider)
        or (settings.GROQ_INPUT_COST_PER_M, settings.GROQ_OUTPUT_COST_PER_M)
    )
    cin, cout = rate
    return round(prompt_tokens / 1_000_000 * cin + completion_tokens / 1_000_000 * cout, 6)


def groq_cost(prompt_tokens: int, completion_tokens: int) -> float:
    """Backwards-compatible helper (default Groq model)."""
    return llm_cost("groq", get_settings().GROQ_MODEL, prompt_tokens, completion_tokens)
