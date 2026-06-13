"""Chunking strategy engine. Importing this package registers all strategies."""

from app.services.chunking import (  # noqa: F401
    character,
    recursive,
    semantic,
    sentence,
    token_based,
)
from app.services.chunking.base import Chunk, assemble
from app.services.chunking.registry import STRATEGY_REGISTRY, get_strategy, list_strategies

__all__ = [
    "Chunk",
    "assemble",
    "STRATEGY_REGISTRY",
    "get_strategy",
    "list_strategies",
]
