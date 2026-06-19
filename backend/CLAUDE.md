# chunklab backend — guide for Claude

FastAPI service for the chunklab monorepo. It runs chunking experiments: parse documents, chunk them with multiple strategies, embed chunks (pgvector), generate a shared QA set, retrieve + LLM-judge, and report cost/accuracy tradeoffs. Heavy work runs in an arq worker, not in request handlers.

**Stack:** FastAPI · SQLAlchemy 2 (async) · asyncpg · pgvector · arq (Redis queue) · FastEmbed (`BAAI/bge-small-en-v1.5`, 384-dim) · HuggingFace `AutoTokenizer` (tiktoken fallback) · docling parser (pypdf/text fallback) · Groq SDK (`llama-3.3-70b-versatile`).

## How to run

All commands assume repo root `/Users/visakh/GitHub/chunking_exp`. `PYTHONPATH`/`--app-dir` point at `backend/`.

```bash
# API (dev)
uvicorn app.main:app --app-dir backend --reload

# Worker (arq) — required for runs/uploads to make progress
arq app.workers.settings.WorkerSettings   # run with cwd=backend, or set PYTHONPATH=backend

# Tests
python -m pytest backend/tests -v

# Seed sample data (needs DB up; via docker)
docker compose exec backend python -m app.scripts.seed

# Full stack
docker compose up --build
```

Both API and worker need Postgres (pgvector) + Redis. Env is read via `app.core.config.Settings`; copy `.env.example` to `.env` (real `.env` is gitignored). Ports: 8000 API, 5432 postgres, 6379 redis, 3000 frontend.

## App entrypoint (`app/main.py`)

`lifespan` runs: `configure_logging()` → `init_db()` (bootstraps DB) → create arq pool on `app.state.arq`. CORS from `settings.cors_origin_list`. All routers mounted under `/api/v1`; plus `GET /health`. Importing `app.services.chunking` at top of `main.py` is load-bearing — it registers every chunking strategy. Don't remove that import.

## Module map

- **`app/core/`** — cross-cutting infra. `config.py` (`Settings`, `get_settings()`), `llm.py` (`get_llm()` Groq client), `embedding.py` (FastEmbed embedder + token counting), `logging.py`, `pricing.py` (embedding/groq/total cost).
- **`app/db/`** — async engine/session, `models_core.py` + `models_results.py` (two schemas), and `setup_db.py` with `init_db()`. **Schema bootstrap lives here, not Alembic** (v0.1 uses idempotent startup `create_all`).
- **`app/schemas/`** — Pydantic request/response models (e.g. `RunCreate`, `RunDetail`, `ChatRequest`). API I/O only; not DB models.
- **`app/api/routers/`** — FastAPI routers: `projects`, `files`, `runs`, `progress`, `results`, `analytics`, `chat`. Thin handlers; delegate to services/repositories/workers.
- **`app/repositories/`** — DB access helpers (queries/persistence). Keep raw SQLAlchemy here, out of routers and services where practical.
- **`app/services/parsing/`** — document parsing (docling primary, pypdf/text fallback), produces `ParsedDocument`.
- **`app/services/chunking/`** — registry-pattern strategies (`sentence`, `character`, `recursive`, `token`, `semantic`). Each implements `split(text, params) -> list[str]` and `label(params) -> str`. `expander.expand()` fans out specs into deduped labeled cells; `assemble()` wraps pieces into `Chunk(index, content, start, end)`.
- **`app/services/embedding/`** — embedding orchestration for chunks/queries (wraps `app.core.embedding`).
- **`app/services/eval/`** — `qa_generator.py` (Groq QA-pair generation w/ gold passages), `retriever.py` (pgvector cosine retrieval, `relevance = 1 - distance`), `judge.py` (Groq LLM judge, temp 0), `metrics.py` (precision/recall@k, MRR, nDCG@k, F2 vs gold passage), `reporting.py` (`build_run_report()` joins combinations + metrics + stats into per-combination dicts; used by results, analytics, chat).
- **`app/services/chat/`** — chat orchestration over project/run/compare/about scopes; streams tokens.
- **`app/services/docs/`** — product-assistant knowledge base: load `app/knowledge/*.md`, embed into `results.doc_chunks`, and retrieve sections for the `about` chat scope (chunklab's RAG, dogfooded). Re-ingest is idempotent (corpus hash); runs as a background task on startup.
- **`app/prompts/`** — `prompt_texts.py` ONLY: `QA_GENERATOR_PROMPT`, `JUDGE_PROMPT`, `CHAT_SYSTEM_PROMPT`, `CHAT_ABOUT_SYSTEM_PROMPT`.
- **`app/workers/`** — arq. `run_pipeline.py` (`run_pipeline`, `parse_file_task`), `settings.py` (`WorkerSettings`, `REDIS_SETTINGS`, `get_arq_pool`), `progress.py` (publishes to Redis pub/sub `run:{id}:progress` + snapshot hash `run:{id}:state`, denormalizes onto Run/RunCombination rows).
- **`app/scripts/`** — `seed.py` (sample data), `prefetch_models.py` (warm HF/embedding cache), `ingest_docs.py` (re-embed the product-assistant knowledge base).

## Rules (do not violate)

1. **Settings only via `get_settings()`** (`app.core.config`). Never read `os.environ` directly in services/routers.
2. **LLM only via `app.core.llm`** (`get_llm()`). Don't instantiate Groq clients elsewhere.
3. **Prompts only in `app/prompts/prompt_texts.py`**. No inline prompt strings in services.
4. **All DB and LLM calls are async.** Use `await`; run blocking work (parsing, embedding, tokenizing) in a thread (the worker already does this).
5. **pgvector dim is 384 and must equal `EMBEDDING_DIM`.** The `chunks.embedding` column is `vector(384)` and the HNSW index assumes it. Changing the embedding model means changing `EMBEDDING_DIM`, the column, and re-creating the index.
6. **Long work goes through `app/workers` (arq), not request handlers.** Endpoints enqueue (`run_pipeline`, `parse_file_task`) and return; the worker does parse/chunk/embed/eval. Report progress via `app/workers/progress.py`.
7. **New chunking strategies register in `app/services/chunking`** (implement `split`/`label`, register in the package so the `import app.services.chunking` in `main.py` picks it up). Add coverage in `tests/test_chunking.py`.
8. **Schema changes go in `app/db/models_core.py` / `models_results.py`** and are created by `setup_db.init_db()`. No migrations framework in v0.1 — keep `init_db()` idempotent (extensions, schemas, `create_all`, HNSW index).

## Two Postgres schemas

- **`core`**: `projects`, `files`, `parsed_documents`, `runs`, `run_combinations`.
- **`results`**: `chunks` (`embedding vector(384)`), `combination_stats`, `qa_pairs`, `retrievals`, `judge_evaluations`, `query_metrics`, `metrics`, `doc_chunks` (`embedding vector(384)`, product-assistant docs).

`init_db()` does: `CREATE EXTENSION vector`, `CREATE SCHEMA core/results`, `create_all` on both metadatas, and the HNSW index `embedding vector_cosine_ops` (m=16, ef_construction=64).

## Worker pipeline (`run_pipeline`)

set run `running` → load combinations + files → parse each file (`ParsedDocument`, in thread) → generate shared QA set once → precompute question embeddings → per combination: `chunking` (per file: split → assemble → count_tokens → embed → bulk-insert `Chunk` rows w/ vectors), then `evaluating` (per QA: retrieve top-k → save `Retrieval` → judge → save `JudgeEvaluation` → `QueryMetrics`), then aggregate `CombinationStats` + `Metrics` → combo `completed`. Run `completed` at the end; any error sets run `failed`.

## Cost model (`app/core/pricing.py`)

`embedding_cost = total_tokens/1000 * EMBED_COST_PER_1K` (notional — local embeddings are free, so combos stay dollar-comparable). `groq_cost = prompt_tokens/1e6*GROQ_INPUT_COST_PER_M + completion_tokens/1e6*GROQ_OUTPUT_COST_PER_M` (real, from `response.usage`). `total_cost = embedding + judge`.

## Conventions

- Settings: `app.core.config.get_settings()`. LLM: `app.core.llm.get_llm()`. Embeddings: `app.core.embedding`.
- All endpoints under `/api/v1`. SSE progress at `GET /runs/{id}/progress/stream`. Chat streams `text/plain` from `POST /chat/stream`.
- File upload multipart field name is `upload`; upload enqueues `parse_file_task`.
- Security: never commit `.env`. Before any `git add`: `git check-ignore -v .env` must match and `git ls-files | grep .env` must be empty.
