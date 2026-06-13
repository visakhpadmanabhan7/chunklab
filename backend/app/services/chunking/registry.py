"""Strategy registry. Strategies register themselves via @register."""

from app.services.chunking.base import ChunkingStrategy

STRATEGY_REGISTRY: dict[str, ChunkingStrategy] = {}


def register(strategy: ChunkingStrategy) -> ChunkingStrategy:
    STRATEGY_REGISTRY[strategy.name] = strategy
    return strategy


def get_strategy(name: str) -> ChunkingStrategy:
    if name not in STRATEGY_REGISTRY:
        raise KeyError(
            f"Unknown chunking strategy '{name}'. "
            f"Available: {sorted(STRATEGY_REGISTRY)}"
        )
    return STRATEGY_REGISTRY[name]


def list_strategies() -> list[str]:
    return sorted(STRATEGY_REGISTRY)
