from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings

# backend/ directory (parent of app/)
BASE_DIR = Path(__file__).resolve().parent.parent.parent
# Repo root (parent of backend/) — where .env lives for local dev
REPO_ROOT = BASE_DIR.parent


class Settings(BaseSettings):
    # ---- LLM (Groq) ----
    GROQ_API_KEY: str = ""
    GROQ_MODEL: str = "llama-3.3-70b-versatile"

    # ---- Embeddings (local, free) ----
    EMBEDDING_MODEL: str = "BAAI/bge-small-en-v1.5"
    EMBEDDING_DIM: int = 384

    # ---- Database (Postgres + pgvector) ----
    DATABASE_URL: str = "postgresql+asyncpg://chunklab:chunklab@localhost:5432/chunklab"

    # ---- Redis (jobs + progress) ----
    REDIS_URL: str = "redis://localhost:6379/0"

    # ---- Retrieval / evaluation ----
    TOP_K: int = 5
    QA_PAIRS_PER_FILE: int = 8
    # cap total QA pairs per run so a run stays feasible on free LLM tiers
    MAX_QA_PAIRS_PER_RUN: int = 10

    # ---- Concurrency (parallelism inside a single run) ----
    # how many combinations are processed at once (each in its own DB session).
    # Embedding is serialized (shared model), so this mainly overlaps one combo's
    # LLM judging with another's embedding; kept at 2 to bound worker memory.
    MAX_CONCURRENT_COMBINATIONS: int = 2
    # shared cap on in-flight Groq calls (QA-gen + judge). Kept modest because
    # free Groq tiers rate-limit aggressively — bursting too hard triggers 429s
    # with escalating back-off that ends up slower than gentle concurrency.
    MAX_CONCURRENT_LLM: int = 3
    # how many files are embedded concurrently within one combination
    MAX_CONCURRENT_EMBED: int = 4

    # ---- Cost model (notional embedding rate + real Groq token cost) ----
    EMBED_COST_PER_1K: float = 0.00002
    GROQ_INPUT_COST_PER_M: float = 0.59
    GROQ_OUTPUT_COST_PER_M: float = 0.79

    # ---- API / CORS ----
    CORS_ORIGINS: str = "http://localhost:3000"

    # ---- File storage ----
    STORAGE_DIR: str = str(BASE_DIR / "app" / "data" / "uploads")

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",") if origin.strip()]

    model_config = {
        # Look for .env at repo root (local dev); in Docker, env is injected directly.
        "env_file": (str(REPO_ROOT / ".env"), ".env"),
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }


@lru_cache
def get_settings() -> Settings:
    return Settings()
