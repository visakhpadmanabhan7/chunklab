"""Light embedding model (FastEmbed / BAAI/bge-small-en-v1.5, 384-dim) and the
matching HuggingFace tokenizer used for honest token counts.

FastEmbed normalizes BGE embeddings by default, so cosine distance is exact.
"""

from functools import lru_cache

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)


@lru_cache
def get_embedding_model():
    import os

    from fastembed import TextEmbedding

    settings = get_settings()
    # Use every available core for the ONNX matrix ops — embedding is the pipeline's
    # dominant CPU cost, so multithreaded inference is the biggest single speed-up.
    threads = os.cpu_count() or 4
    logger.info("Loading embedding model %s (onnx threads=%s)", settings.EMBEDDING_MODEL, threads)
    return TextEmbedding(model_name=settings.EMBEDDING_MODEL, threads=threads)


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts; returns one 384-float vector per text."""
    if not texts:
        return []
    model = get_embedding_model()
    # Larger batches amortise per-call overhead; the ONNX session is multithreaded.
    return [vec.tolist() for vec in model.embed(texts, batch_size=128)]


def embed_query(text: str) -> list[float]:
    return embed_texts([text])[0]


@lru_cache
def get_tokenizer():
    """The embedding model's own tokenizer (HF). tiktoken is a fallback."""
    settings = get_settings()
    try:
        from transformers import AutoTokenizer

        return ("hf", AutoTokenizer.from_pretrained(settings.EMBEDDING_MODEL))
    except Exception as exc:  # pragma: no cover - fallback path
        logger.warning("HF tokenizer load failed (%s); falling back to tiktoken", exc)
        import tiktoken

        return ("tiktoken", tiktoken.get_encoding("cl100k_base"))


def count_tokens(text: str) -> int:
    kind, tok = get_tokenizer()
    if kind == "hf":
        return len(tok.encode(text, add_special_tokens=False))
    return len(tok.encode(text))
