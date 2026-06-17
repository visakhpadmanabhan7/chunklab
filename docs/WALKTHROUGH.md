# chunklab — Developer Walkthrough

A complete, code-grounded tour of the system in 16 steps, from the big picture to the worker pipeline, evaluation, and frontend. Every section was verified against the source; key claims cite `file:line`. Appendices embed real chunking output, evaluation scores (including a live LLM-judge call), and all 19 architecture decisions.

## Contents


**Foundations**

- [1. Big picture & end-to-end data flow](#1-big-picture-end-to-end-data-flow)
- [2. Runtime topology — the 5 containers](#2-runtime-topology-the-5-containers)
- [3. Config & secrets](#3-config-secrets)

**Backend core**

- [4. The data model — two schemas + pgvector](#4-the-data-model-two-schemas-pgvector)
- [5. The API layer — FastAPI app & routers](#5-the-api-layer-fastapi-app-routers)
- [6. Documents in — upload → parse → store](#6-documents-in-upload-parse-store)

**Pipeline & eval**

- [7. The chunking engine — registry, 5 strategies, expander](#7-the-chunking-engine-registry-5-strategies-expander)
- [8. Embedding, tokenizing & cost](#8-embedding-tokenizing-cost)
- [9. The run pipeline (the orchestration heart)](#9-the-run-pipeline-the-orchestration-heart)

**Backend core**

- [10. Progress — Redis pub/sub + snapshot → SSE](#10-progress-redis-pub-sub-snapshot-sse)

**Pipeline & eval**

- [11. Evaluation — QA gen, retrieve, judge, metrics](#11-evaluation-qa-gen-retrieve-judge-metrics)

**Read side**

- [12. Reporting & analytics (the read side)](#12-reporting-analytics-the-read-side)
- [13. Chat / RAG over results](#13-chat-rag-over-results)

**Frontend**

- [14. Frontend architecture](#14-frontend-architecture)
- [15. The builder → progress → dashboard UI flow](#15-the-builder-progress-dashboard-ui-flow)

**Ops**

- [16. CI, Docker images, docs & ops](#16-ci-docker-images-docs-ops)

- [Appendix A — Chunking examples](#appendix-a--chunking-strategies-real-output)
- [Appendix B — Evaluation scores](#appendix-b--evaluation-scores-real-numbers)
- [Appendix C — Architecture decisions](#appendix-c--architecture-decisions-19)


## 1. Big picture & end-to-end data flow

*Foundations*


> chunklab is a full-stack lab for comparing RAG chunking strategies head-to-head: it parses your documents, chunks them every way you ask, embeds and scores each variant against a shared QA set, and surfaces cost-vs-accuracy results plus a RAG chatbot.

- Five services cooperate (README.md:26-34, docs/ARCHITECTURE.md:22-34): a Next.js frontend (:3000), a FastAPI backend (:8000), an arq worker, Postgres+pgvector (:5432), and Redis (:6379). Backend and worker share one image (Dockerfile.backend) with different entrypoints (uvicorn vs `arq app.workers.settings.WorkerSettings`).
- Core seam = sync API vs async worker (docs/ARCHITECTURE.md:116-149): handlers only validate, persist intent, enqueue jobs, and read results; all parsing/embedding/judge LLM work is deferred to arq via the shared pool created in the FastAPI lifespan (`app.state.arq`, main.py:39). The lone direct-Groq exception is chat streaming.
- Upload → parse is interactive (run_pipeline.py:73-87, docs/ARCHITECTURE.md:155-169): POST a file (multipart field `upload`), backend saves bytes and enqueues `parse_file_task`, which parses once into a `ParsedDocument` (docling primary, pypdf/text fallback) and then deletes the raw upload, keeping only clean text (run_pipeline.py:61-67).
- Run = a combinatorial matrix (docs/ARCHITECTURE.md:171-181): `expander.expand()` fans each `{strategy, params}` spec out by `sizes:[...]` into deduped, labeled cells (expander.py:20-37), persisting one `RunCombination` per cell, then enqueues `run_pipeline(run_id)`.
- The pipeline generates one shared QA set per run BEFORE chunking (run_pipeline.py:127-154): Groq makes `{question, reference_answer}` pairs over gold passages (QA_PAIRS_PER_FILE=8, capped by MAX_QA_PAIRS_PER_RUN=10, config.py:29-31), and question embeddings are precomputed once and reused for every combination — the identical QA set is what makes combinations comparable.
- Per combination (run_pipeline.py:192-335): chunk → token-count → embed → bulk-insert `Chunk` rows with 384-dim vectors (status `chunking`); then per QA pair, pgvector cosine-KNN scoped to that combination (`relevance = 1 - distance`, retriever.py:26-39, status `evaluating`) feeds a Groq LLM-judge (relevance/faithfulness/context-precision/recall) plus computed metrics (precision@k, recall@k, MRR, nDCG, F2), aggregated into `CombinationStats` + `Metrics`.
- Two schemas keep app state and experiment output separate (docs/ARCHITECTURE.md:45-54): `core` (projects, files, parsed_documents, runs, run_combinations) vs `results` (chunks+vector(384), combination_stats, qa_pairs, retrievals, judge_evaluations, metrics); `init_db()` bootstraps everything idempotently at startup (no Alembic), including the HNSW cosine index.
- Live progress is dual-written for robustness (docs/ARCHITECTURE.md:254-287): the worker PUBLISHes to `run:{id}:progress` and HSETs a 24h snapshot `run:{id}:state`, plus denormalizes onto rows; the backend relays both over SSE (`GET /runs/{id}/progress/stream`) so late joiners get a replayed snapshot then live events.
- Read side is fully synchronous (docs/ARCHITECTURE.md:235-250): `reporting.build_run_report()` joins run_combinations+metrics+combination_stats into per-combination dicts — the single source of truth reused by results, analytics (compare / cost-accuracy tradeoff / cross-run), and the `POST /chat/stream` chatbot, which streams Groq tokens as text/plain.

```
Browser (Next.js :3000)
  | HTTP / SSE / streamed text
  v
FastAPI backend (:8000)  --SQL-->  Postgres+pgvector (:5432)
  |  enqueue / subscribe            core schema  +  results schema (vector 384)
  v                                       ^
Redis (:6379)  --dequeue/publish-->  arq worker (same image)
 job queue + pub/sub + snapshot      parse -> QA-gen(once) -> [per combo:
                                       chunk -> embed -> store ->
                                       retrieve -> judge -> score] -> aggregate
                                     (publishes progress back to Redis)
```

**In one line:** chunklab turns "which chunking strategy is best for RAG?" into a reproducible experiment: a sync FastAPI API records intent and an async arq worker parses, chunks, embeds, retrieves, and LLM-judges every strategy variant against one shared QA set, streaming progress over Redis+SSE and exposing the joined results to analytics and a chatbot.


## 2. Runtime topology — the 5 containers

*Foundations*


> `docker compose up --build` brings up five services — postgres, redis, backend, worker, frontend — wired together so the API enqueues heavy work onto a worker that shares its exact image.

- **postgres** runs `pgvector/pgvector:pg16` and publishes container `5432` on host **5433** (docker-compose.yml:9-10). On first boot it runs `infra/postgres/init.sql`, mounted read-only into `/docker-entrypoint-initdb.d` (docker-compose.yml:13), which does `CREATE EXTENSION vector` plus the `core` and `results` schemas (init.sql:4-6); the app's `setup_db.py` also ensures these idempotently.
- **redis** runs `redis:7-alpine`, host **6380** -> container `6379` (docker-compose.yml:20-24); it backs the arq job queue. Both stateful services have healthchecks (`pg_isready`, `redis-cli ping`) so dependents wait via `condition: service_healthy` (docker-compose.yml:14-31, 50-53).
- **backend** and **worker** build from the *same* `Dockerfile.backend` (docker-compose.yml:34-36, 61-63) and differ only by command: backend uses the image default `uvicorn app.main:app ... :8000` (Dockerfile.backend:37), worker overrides it with `arq app.workers.settings.WorkerSettings` (docker-compose.yml:66).
- **backend** publishes container `8000` on host **8001** (docker-compose.yml:39-40) and has a healthcheck hitting `/health` (docker-compose.yml:54-58). **worker** exposes no ports — it only pulls jobs from redis.
- Both backend and worker get identical wiring via env: `DATABASE_URL` (asyncpg to `postgres:5432`), `REDIS_URL` (`redis://redis:6379/0`), and `STORAGE_DIR=/app/data/uploads` (docker-compose.yml:42-45, 68-71), plus secrets from `.env` via `env_file` (docker-compose.yml:41, 67). Note services talk over the compose network using internal ports (5432/6379), not the remapped host ports.
- Two named volumes are shared between backend and worker: **uploads** mounted at `/app/data/uploads` (the `STORAGE_DIR` for parsed/uploaded files) and **hf_cache** at `/root/.cache` (docker-compose.yml:46-48, 72-74). Sharing `hf_cache` lets both reuse the same FastEmbed/HuggingFace model downloads — the Dockerfile sets `HF_HOME=/root/.cache/huggingface` and `FASTEMBED_CACHE_PATH=/root/.cache/fastembed` (Dockerfile.backend:33-34).
- The backend image is CPU-only and deliberate about torch: it installs the CPU torch/torchvision pair first, then the rest of `requirements.txt`, then force-reinstalls the matched CPU pair so docling's transitive pull doesn't break `torchvision::nms` (Dockerfile.backend:16-26). App code is added under `/app/backend` with `PYTHONPATH=/app/backend`, no packaging step (Dockerfile.backend:29-30).
- **frontend** builds from `Dockerfile.frontend` as a Next.js standalone image (multi-stage: `node:22-slim` build -> run, copying `.next/standalone`, `.next/static`, `public`), serving `node server.js` on host **3000** (Dockerfile.frontend:15-24, docker-compose.yml:90-91). `NEXT_PUBLIC_API_BASE_URL` is a build arg inlined at build time, set to `http://localhost:8001` so the browser reaches the backend on the host port (docker-compose.yml:87-88, Dockerfile.frontend:11-12).
- Startup ordering: postgres+redis must be healthy before backend/worker start; worker also waits on backend `service_started`, and frontend waits on backend `service_healthy` (docker-compose.yml:49-53, 75-81, 92-94). Four named volumes persist state: `pgdata`, `redisdata`, `uploads`, `hf_cache` (docker-compose.yml:96-100).

```
                       host ports
  browser :3000 ─────────────────────────────┐
                                              v
                                       ┌─────────────┐
                                       │  frontend   │  (Next.js standalone)
                                       │  :3000      │
                                       └──────┬──────┘
              NEXT_PUBLIC_API_BASE_URL=:8001  │  (browser->host)
                                              v
  api :8001 ───────────────────────────► ┌─────────────┐
                                          │  backend    │  uvicorn :8000
                                          │ Dockerfile  │
                                          │ .backend    │
                                          └──┬───┬───┬──┘
                                  enqueue job │   │   │ share image + volumes
                                   (REDIS_URL)│   │   v
                                              │   │ ┌─────────────┐
                                              │   │ │  worker     │  arq
                                              │   │ │ (no ports)  │  WorkerSettings
                                              │   │ └──┬───┬──────┘
                          ┌───────────────────┘   │    │   │
                          v                        v    v   v
                   ┌────────────┐           ┌────────────┐ │ volumes:
                   │  redis     │◄──────────│  postgres  │ │  uploads -> /app/data/uploads
                   │ :6380->6379│           │:5433->5432 │ │  hf_cache-> /root/.cache
                   └────────────┘           │ pgvector   │◄┘  (backend+worker)
                                            │ core/results│
                                            └────────────┘
                                            init.sql: CREATE EXTENSION vector
```

**In one line:** Five compose services — pgvector postgres, redis, a FastAPI backend and an arq worker that share one Dockerfile.backend image plus the uploads/hf_cache volumes, and a standalone Next.js frontend — are remapped to host ports 5433/6380/8001/3000 and gated by healthchecks.


## 3. Config & secrets

*Foundations*


> All runtime configuration flows through a single cached pydantic-settings object, with the Groq API key as the only required secret and `.env` kept out of git.

- A single `Settings(BaseSettings)` class in `config.py:12` holds every tunable: Groq model/key, embedding model + 384-dim, `DATABASE_URL`, `REDIS_URL`, retrieval/eval knobs (`TOP_K`, `QA_PAIRS_PER_FILE`, `MAX_QA_PAIRS_PER_RUN`), cost-model rates, CORS, and `STORAGE_DIR` (`config.py:14-42`).
- Access is exclusively via `get_settings()`, an `@lru_cache`'d factory (`config.py:56-58`) so `Settings()` is instantiated once per process and reused as a singleton; per the conventions, code never reads `os.environ` directly.
- Sources are layered by pydantic-settings: real OS environment variables take precedence, then `.env` files. `model_config` (`config.py:48-53`) lists two env files — repo-root `.env` (computed from `REPO_ROOT`, `config.py:9`) for local dev and `.env` in cwd — with `extra: "ignore"` so unknown keys (e.g. `POSTGRES_USER`) don't error.
- Every field has a default (`config.py:14-42`), so the app boots without a `.env`; in Docker, env is injected directly by compose rather than read from a file (`config.py:49`).
- `GROQ_API_KEY` defaults to empty string (`config.py:14`) and is the one secret with no usable fallback — there is no embedding API key since embeddings run locally/free.
- The key is consumed only in `app.core.llm`: `GroqProvider.__init__` passes `settings.GROQ_API_KEY` into `groq.AsyncGroq(...)` (`llm.py:34`), and `get_llm()` lazily builds one cached provider (`llm.py:86-92`). There is no explicit pre-flight gate — a blank key surfaces as an auth failure on the first Groq call (QA gen, judge, or chat), not at startup.
- `.env.example` is the committed template (`.env.example:7` shows the placeholder key) and notably ships `GROQ_MODEL=llama-3.1-8b-instant` for the free tier, overriding the code default of `llama-3.3-70b-versatile` (`config.py:15`).
- `.gitignore:1-7` blocks `.env` and `.env.*` while whitelisting `!.env.example`, plus `*.key`/`*.pem`/`secrets/`, so the only checked-in secrets file is the placeholder template.
- Two derived helpers add convenience without new env vars: `cors_origin_list` splits comma-separated `CORS_ORIGINS` (`config.py:44-46`), and `STORAGE_DIR` is computed from `BASE_DIR` (`config.py:42`).

```
OS env  ─┐
         ├─► pydantic Settings ──► get_settings() [@lru_cache] ──► one singleton
.env  ───┘   (defaults if unset)        │
(repo root / cwd)                        ├─► GROQ_API_KEY ──► get_llm() ──► AsyncGroq
                                         ├─► DATABASE_URL / REDIS_URL
                                         └─► EMBEDDING_DIM=384, TOP_K, cost rates ...

.gitignore: .env blocked, .env.example tracked
```

**In one line:** Configuration is one cached pydantic `Settings` singleton fed by OS env then `.env` (gitignored, with `.env.example` as template), where `GROQ_API_KEY` is the sole required secret and is only enforced lazily when `get_llm()` first calls Groq.


## 4. The data model — two schemas + pgvector

*Backend core*


> All persistence lives in one SQLAlchemy MetaData split across two Postgres schemas (core for app data, results for experiment output), wired together by cross-schema foreign keys and a pgvector HNSW index, and bootstrapped idempotently at startup.

- **One shared MetaData, two schemas.** `Base` defines a single `MetaData()` and `CoreBase`/`ResultsBase` are just aliases for it (base.py:17-23). Schema membership is set per-table via `__table_args__ = {"schema": "core"}` / `{"schema": "results"}` (e.g. models_core.py:20, models_results.py:22) rather than separate metadata objects.
- **Why one MetaData matters.** The module docstring spells it out (base.py:1-8): a single MetaData is required so cross-schema FKs (e.g. `results.chunks.file_id -> core.files.id`) resolve and `create_all` can topologically sort table creation order across both schemas.
- **`core` schema = application data.** Five tables: `projects`, `files`, `parsed_documents`, `runs`, `run_combinations` (models_core.py). UUID PKs via a shared `_pk()` helper (models_core.py:14-15), `TimestampMixin` adds `created_at` (base.py:26-27), and intra-schema FKs use `ondelete="CASCADE"` so deleting a project cascades to its files and runs.
- **`results` schema = experiment output.** Six tables: `chunks`, `combination_stats`, `qa_pairs`, `retrievals`, `judge_evaluations`, `metrics` (models_results.py). Several reference back into `core` (e.g. `chunks.combination_id -> core.run_combinations.id` and `chunks.file_id -> core.files.id`, models_results.py:25-30; `qa_pairs.run_id -> core.runs.id`, models_results.py:64-66) — these are the cross-schema FKs.
- **The vector column is data-driven 384-dim.** `EMBEDDING_DIM = get_settings().EMBEDDING_DIM` (models_results.py:13) feeds `embedding: Mapped[list[float]] = mapped_column(Vector(EMBEDDING_DIM))` (models_results.py:35), so the pgvector column width is tied to the configured embedding model and must match `EMBEDDING_DIM`.
- **Idempotent bootstrap in `init_db()`.** Inside one `engine.begin()` transaction it runs `CREATE EXTENSION IF NOT EXISTS vector`, `CREATE SCHEMA IF NOT EXISTS core/results`, then `Base.metadata.create_all` (setup_db.py:23-28). Importing `models_core` and `models_results` at the top (setup_db.py:12-15) is load-bearing — it registers every table on the shared metadata before `create_all` runs.
- **HNSW cosine index, created in SQL not the ORM.** After tables exist, `init_db` issues `CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw ON results.chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)` (setup_db.py:30-36) — HNSW needs no training and supports inserts, and `vector_cosine_ops` matches the cosine-distance retrieval used downstream.
- **Uniqueness encodes one-to-one relationships.** `parsed_documents.file_id` is `unique=True` (one parse per file, models_core.py:69), and `combination_stats`, `judge_evaluations`, and `metrics` each have `unique=True` on their FK (one stats/metrics row per combination, one judgment per retrieval; models_results.py:46, 102, 123).
- **JSONB + array columns for flexible payloads.** Config-shaped fields use `JSONB` (`File.parse_options`, `Run.config`, `RunCombination.params`; models_core.py:55, 88, 114), and retrievals store parallel Postgres arrays `retrieved_chunk_ids ARRAY(UUID)` and `scores ARRAY(Float)` (models_results.py:88-91).

```
Base.metadata (single MetaData)
+-----------------------------+        +--------------------------------------+
| schema: core                |        | schema: results                      |
|                             |        |                                      |
| projects                    |        | chunks  (embedding vector(384))      |
|   └─< files                 |<───────|   ├─ combination_id ─┐  + HNSW index |
|        ├─< parsed_documents |        |   └─ file_id ────────┼──┐            |
|   └─< runs                  |<───────|  combination_stats ──┘  │ (cross-    |
|        └─< run_combinations |<──┐    |  qa_pairs ─< retrievals │  schema    |
+-----------------------------+   │    |              └─< judge_evaluations FKs)|
                                  └────|  metrics ─────────────┘              |
                                       +--------------------------------------+
init_db(): CREATE EXTENSION vector; CREATE SCHEMA core/results;
           create_all (sorts cross-schema FKs); CREATE INDEX ... hnsw (cosine)
```

**In one line:** chunklab persists everything in one SQLAlchemy MetaData partitioned into a `core` schema (projects/files/runs) and a `results` schema (chunks-with-384-dim-vectors/metrics), joined by cross-schema foreign keys and an HNSW cosine index, all created idempotently by `init_db()` at startup.


## 5. The API layer — FastAPI app & routers

*Backend core*


> How the FastAPI app boots, wraps every request in middleware, and exposes thin async handlers that validate input, persist rows, and hand heavy work to the arq worker.

- **Lifespan bootstraps the app**: `lifespan` runs `configure_logging()`, then `init_db()` (idempotent schema/extension/index creation), then opens the shared arq pool onto `app.state.arq`, and closes it on shutdown (main.py:35-42). Importing `app.services.chunking` at module top is load-bearing — it registers every chunking strategy via side effect (main.py:11).
- **Three middleware layers, applied in order**: SlowAPI rate limiting (`app.state.limiter` + `RateLimitExceeded` handler + `SlowAPIMiddleware`, main.py:48-50), CORS from `settings.cors_origin_list` with credentials and wildcard methods/headers (main.py:53-59), and a custom HTTP request-logging middleware that times each request and logs at info/warning/error by status class, skipping `/health` (main.py:63-83).
- **Rate limits are in-memory, per-process**: a generous global default of `600/minute` keyed by client IP (`get_remote_address`) protects everything, while expensive routes opt into stricter per-route caps — e.g. run creation is `@limiter.limit("30/minute")` (ratelimit.py:12, runs.py:21).
- **Routers mounted under `/api/v1`**: all eight routers (`projects, files, runs, progress, results, analytics, chat, logs`) are included under the `API_PREFIX` in one loop, plus a single unversioned `GET /health` returning `{"status": "ok"}` (main.py:32, 86-92).
- **Dependencies are tiny and shared**: `get_session` (re-exported via deps.py:3) yields a request-scoped `AsyncSession` from the `async_sessionmaker` built on the async engine with `pool_pre_ping=True` and `expire_on_commit=False` (session.py:9-12, engine.py:7-9); `get_arq` just returns `request.app.state.arq` (deps.py:6-8).
- **Handlers are thin and fully async**: each endpoint injects `session`/`arq` via `Depends`, fetches with `session.get(...)`, raises `HTTPException(404/400/...)` on missing or invalid input, and returns Pydantic response models built with `model_validate` — no business logic in the router (runs.py:73-128).
- **POST /runs = expand + persist + enqueue**: `create_run` validates the project exists, calls `expand(...)` on the submitted combination specs (translating a `KeyError` into HTTP 400, and an empty result into 'No valid combinations'), normalizes `file_ids` (the `"all"` literal or a list of UUIDs), inserts a `Run` (status `queued`, config snapshot, `total_combinations`) plus one `RunCombination` per expanded cell, commits, then `arq.enqueue_job("run_pipeline", run.id)` so the worker does parse/chunk/embed/eval (runs.py:29-70).
- **Schemas separate input from output**: `RunCreate` accepts `combinations` (list of `CombinationSpec`) and `file_ids: list[UUID] \| Literal["all"]`; `RunOut`/`RunDetail`/`CombinationOut` use `from_attributes=True` for ORM serialization (run.py:13-52). `get_run` deliberately builds `RunDetail` from `RunOut` plus an explicitly-queried combos list to avoid lazy-loading the relationship under the async session (would raise `MissingGreenlet`) (runs.py:91-98).

```
POST /api/v1/projects/{id}/runs
        |
   [SlowAPI rate-limit] -> [CORS] -> [log_requests]
        |
   create_run handler
        |  Depends(get_session) -> AsyncSession
        |  Depends(get_arq)     -> app.state.arq
        v
   validate project -> expand(combinations) -> insert Run + RunCombinations -> commit
        |
        +--> arq.enqueue_job("run_pipeline", run.id) --> [worker]
        v
   201 RunOut
```

**In one line:** The FastAPI app boots its DB and arq pool in a lifespan, wraps every request in rate-limit/CORS/logging middleware, and routes to thin async handlers under /api/v1 that validate, persist, and enqueue heavy work (e.g. POST /runs expands combinations into rows then enqueues run_pipeline).


## 6. Documents in — upload → parse → store

*Backend core*


> Uploaded files are saved to disk, parsed off-request by an arq worker into clean text, then the raw upload is deleted — only the extracted text survives.

- Upload is a thin handler: POST /projects/{project_id}/files (multipart field `upload`) validates the project, writes bytes to `{STORAGE_DIR}/{project_id}/{file_id}_{filename}`, inserts a `File` row with status `uploaded` and `parse_options={parser, ocr, tables}`, then enqueues `parse_file_task` and returns 201 (files.py:21-60). Defaults are parser=`docling`, ocr=True, tables=True (files.py:27-29); rate-limited 120/min (files.py:22).
- Parsing runs in the arq worker, never in the request: `parse_file_task` loads the `File`, sets status `parsing`, calls `_ensure_parsed`, and on any exception sets status `failed` plus stores the message in `file.error` (run_pipeline.py:73-86).
- `_ensure_parsed` is idempotent: if a `ParsedDocument` already exists for the file it is returned as-is; otherwise it parses via `asyncio.to_thread(parse_file, ...)` to keep the blocking CPU-bound parse off the event loop (run_pipeline.py:43-51).
- Parser selection happens in `parse_file`: `parser="fast"` skips docling entirely and goes straight to the fallback; otherwise docling is used only for known extensions (`.pdf/.docx/.pptx/.html/.htm/.md/.markdown`), and anything else falls through to the fallback (service.py:18-44).
- Docling auto-fallback is twofold: it falls back to `parse_with_fallback` if docling raises OR if it returns empty/whitespace-only text, with a warning logged in both cases (service.py:38-44). Docling exports the document to markdown and reports page_count when available (docling_parser.py:35-43).
- Docling converters are cached per (ocr, tables) combo via `@lru_cache(maxsize=8)` so models load once, and conversions are serialized under a `threading.Lock` because the pipeline is CPU-bound and not thread-safe (docling_parser.py:14-18,31-34).
- The fallback parser uses `pypdf` for PDFs (joining per-page `extract_text()` with blank lines) and reads everything else as UTF-8 with `errors="ignore"`; both paths tag `parser_used="fallback"` (fallback_parser.py:10-33).
- After a successful parse the result is persisted as a `ParsedDocument` (clean_text, char_count, page_count), the `File` is marked `parsed` with `parser_used` recorded, and the raw upload is deleted from disk with `storage_path` blanked — only the extracted text is retained since that is all chunking needs (run_pipeline.py:52-70).
- Read-back endpoints: GET /files/{file_id} returns file status, and GET /files/{file_id}/parsed returns the `ParsedDocument` or 404 "File not parsed yet"; DELETE removes the disk file (if still present) and the row (files.py:71-101).

```
POST /files ──> save bytes to disk ──> insert File(status=uploaded)
                                            │
                                            └─ enqueue parse_file_task ──┐
                                                                         ▼
                                                          arq worker: _ensure_parsed
                                                                         │
                                              parse_file (in thread, asyncio.to_thread)
                                                 │ parser="fast"? ─yes─> fallback
                                                 │ ext docling-able? ─yes─> docling
                                                 │       └─ raises / empty? ─> fallback
                                                 ▼
                                          ParsedDocument(clean_text)
                                                 │
                              File.status=parsed, parser_used set
                              delete raw upload, storage_path=""
```

**In one line:** Files are stored to disk on upload, then an arq worker parses them off-request with docling (falling back to pypdf/text on failure or empty output) and keeps only the extracted text, discarding the original upload.


## 7. The chunking engine — registry, 5 strategies, expander

*Pipeline & eval*


> A self-registering strategy registry behind a structural Protocol, five interchangeable chunkers, and a matrix expander that fans run specs out into deduplicated, labeled combinations the pipeline executes.

- The contract is a structural `Protocol`, not a base class: `ChunkingStrategy` (base.py:15-25) is `@runtime_checkable` and requires only a `name: str` attribute plus `split(text, params) -> list[str]` and `label(params) -> str`. Strategies are plain classes that match the shape; there is no inheritance.
- The registry is a single module-level dict keyed by `strategy.name` (registry.py:5-10). `register(strategy)` inserts and returns the instance; `get_strategy(name)` raises `KeyError` with the sorted available names if missing (registry.py:13-19); `list_strategies()` returns them sorted (registry.py:22-23).
- Self-registration happens at import time: each strategy file ends with `register(SomeStrategy())` (e.g. sentence.py:27, character.py:22, recursive.py:25, token_based.py:39, semantic.py:61). The `import app.services.chunking` in `main.py` is what populates the registry, so dropping it would silently empty the run options.
- The five strategies: `character` is dependency-free fixed-size windows with overlap, `step = max(size - overlap, 1)` (character.py:9-14); `token` uses the embedding model's own tokenizer via `get_tokenizer()`, encoding then decoding fixed token windows so size is measured in real model tokens, with an HF/tiktoken branch (token_based.py:21-31); `sentence` wraps llama-index `SentenceSplitter` (token-measured, sentence-aware) (sentence.py:14-19); `recursive` wraps langchain `RecursiveCharacterTextSplitter` (recursive.py:10-17); `semantic` embeds sentences and breaks where consecutive cosine distance exceeds a percentile cutoff (semantic.py:23-54).
- Param keys are read defensively with fallbacks so the same spec works across strategies: most read `params.get('size', params.get('chunk_size', ...))` plus `overlap` (e.g. character.py:10-11), and `semantic` accepts `breakpoint_percentile` or `threshold`, normalizing a 0..1 fraction to a percentile by `*100` (semantic.py:28-31).
- `semantic` is self-contained (no langchain-experimental): it sentence-splits via regex `(?<=[.!?])\s+` (semantic.py:12-17), embeds with `embed_texts`, and since fastembed returns L2-normalized vectors it computes cosine distance as `1 - dot` of adjacent sentence pairs (semantic.py:37-40), then cuts at `np.percentile(distances, percentile)` (semantic.py:44-45); `<= 1` sentence short-circuits to the raw text.
- `expand()` turns a run's combination specs into concrete cells (expander.py:20-39): a spec with `params.sizes: [...]` fans out into one combination per size (`{**base, 'size': s}`), otherwise it stays a single combination (expander.py:27-29). `get_strategy(strategy)` is called inside the loop purely to validate the name (expander.py:32).
- Deduplication is by `label`, not by params: each computed `strat.label(params)` is checked against a `seen` set and skipped if already present (expander.py:33-37). Labels follow a `strategy·size/overlap` convention (e.g. `sentence·512/20`, `semantic·pct95`), so two specs producing the same label collapse to one `ExpandedCombination(strategy, params, label)`.
- `assemble(text, pieces)` (base.py:28-47) wraps raw string pieces into `Chunk(index, content, start, end)`, best-effort locating each piece sequentially via `text.find` (cursor advances by 1 to tolerate overlap, retries from 0, falls back to `(0,0)` if unfindable) so downstream gold-span overlap scoring has char offsets; blank/whitespace-only pieces are filtered.

```
run spec(s)
   |
   v
expand()  --- per spec: pop 'sizes' -> fan out one params/size
   |              get_strategy(name)  (validate)
   |              label(params) -> dedup via `seen` set
   v
[ExpandedCombination(strategy, params, label), ...]
   |
   v  (pipeline, per combination)
get_strategy(name).split(text, params) -> list[str]
   |
   v
assemble(text, pieces) -> [Chunk(index, content, start, end)]

registry: {name -> strategy}  <- register(...) at import time
   ^                                (sentence|character|recursive|token|semantic)
   |__ populated by `import app.services.chunking` in main.py
```

**In one line:** Strategies self-register into a name-keyed dict behind a runtime-checkable Protocol, and the expander fans run specs into label-deduplicated combinations that the pipeline runs through `split()` then `assemble()`.


## 8. Embedding, tokenizing & cost

*Pipeline & eval*


> Each chunk is embedded with a local FastEmbed BGE model and token-counted with the model's own HF tokenizer, then priced via a notional embedding rate plus the real Groq judge cost so chunking combinations are dollar-comparable.

- Embeddings are produced locally by FastEmbed's `BAAI/bge-small-en-v1.5` (384-dim) — `get_embedding_model()` lazily loads it via `lru_cache` (embedding.py:15-21) using `settings.EMBEDDING_MODEL`/`EMBEDDING_DIM` (config.py:18-19); `embed_texts()` returns one 384-float vector per text (embedding.py:24-29) and `embed_query()` is the single-text helper (embedding.py:32-33).
- FastEmbed normalizes BGE vectors by default, so cosine distance is exact (embedding.py:4) — this is what lets pgvector retrieval use `relevance = 1 - distance` downstream.
- Token counts use the embedding model's *own* HuggingFace tokenizer: `get_tokenizer()` tries `AutoTokenizer.from_pretrained(EMBEDDING_MODEL)` and tags it `"hf"` (embedding.py:36-43); on any load failure it logs a warning and falls back to tiktoken `cl100k_base` tagged `"tiktoken"` (embedding.py:44-48).
- `count_tokens()` branches on that tag — HF path encodes with `add_special_tokens=False` (so [CLS]/[SEP] aren't counted), tiktoken path is a plain `encode` (embedding.py:51-55).
- Embedding cost is *notional*, not a real API charge: local embeddings are free, so `embedding_cost = total_tokens/1000 * EMBED_COST_PER_1K` (pricing.py:11-13) with `EMBED_COST_PER_1K = 0.00002` (config.py:34) just makes combos dollar-comparable.
- Groq cost is real, computed from actual usage tokens: `groq_cost = prompt_tokens/1e6 * GROQ_INPUT_COST_PER_M + completion_tokens/1e6 * GROQ_OUTPUT_COST_PER_M` (pricing.py:16-22), with rates 0.59 / 0.79 per 1M tokens for `llama-3.3-70b-versatile` (config.py:15,35-36); both functions round to 6 decimals.
- These wire together in the worker per combination: chunk contents are token-counted (`count_tokens` per chunk) and embedded off-thread (`asyncio.to_thread(embed_texts, ...)`), accumulating `total_tokens` (run_pipeline.py:216-234); afterward `e_cost = embedding_cost(total_tokens)` and `j_cost = groq_cost(judge_in, judge_out)` feed a `CombinationStats` row with `total_cost_usd = e_cost + j_cost` (run_pipeline.py:299-309).
- Both `embed_texts` and `count_tokens` are CPU-bound/blocking, so the pipeline runs embedding in a thread; the cached model and tokenizer keep repeated combinations cheap (embedding.py:15,36).
- Per-chunk results persist `token_count` and `char_count` (= `len(content)`) alongside the vector on each `Chunk` row (run_pipeline.py:229-231), enabling per-combination avg-tokens-per-chunk reporting.

```
chunk text
   │
   ├─ count_tokens() ──> HF tokenizer (add_special_tokens=False)
   │                        └─(load fail)─> tiktoken cl100k_base
   │                                            │
   │                                       total_tokens ──> embedding_cost(notional)
   │
   └─ embed_texts() ──> FastEmbed bge-small (384-d, normalized) ──> Chunk.embedding

Groq judge usage (prompt/completion tokens) ──> groq_cost (real)

total_cost_usd = embedding_cost + groq_cost   (per CombinationStats)
```

**In one line:** chunklab embeds chunks with a local 384-dim FastEmbed BGE model, counts tokens with the model's own HF tokenizer (tiktoken fallback), and prices each combination as a notional embedding cost plus the real Groq judge cost.


## 9. The run pipeline (the orchestration heart)

*Pipeline & eval*


> `run_pipeline` is the single arq task that turns a Run row into scored results: it parses files once, generates one shared QA set, then evaluates every chunking combination against it, emitting progress at each step.

- Entry + setup: `run_pipeline(ctx, run_id)` loads the `Run`, flips it to `running` with `progress=0.0`, and announces it (run_pipeline.py:96-100). It then loads the combinations for this run (run_pipeline.py:102-110) and the target files via `_load_files`, which reads `config['file_ids']` (a list, or `'all'`/absent for the whole project) (run_pipeline.py:182-189). Empty file set short-circuits to `failed` (run_pipeline.py:114-119).
- Parse-once: each file is parsed up front into `parsed_map` via `_ensure_parsed`, which returns an existing `ParsedDocument` or parses in a thread (`asyncio.to_thread(parse_file, ...)`), then deletes the raw upload from disk and blanks `storage_path` — only extracted text is retained (run_pipeline.py:43-70, 121-125).
- QA generated once per run, not per combo: it builds a shared evaluation set sized by `qa_per_file`/`max_qa` from `run.config` (falling back to settings) and stops at `MAX_QA_PAIRS_PER_RUN` (run_pipeline.py:131-149). Each question carries a gold source passage (`source_chunk_text`, offsets). Question embeddings are precomputed once into `q_vectors` so they are reused across every combination (run_pipeline.py:152-153).
- Per-combination loop: for each combo it calls `_process_combination`, then sets `run.progress = (ci+1)/total`, commits, and emits the run-level percentage — so the run bar advances one notch per finished combination (run_pipeline.py:156-164).
- Inside a combo — chunk→embed→store (first half): it resolves the strategy via `get_strategy(combo.strategy)` (run_pipeline.py:195), sets status `chunking`, then per file runs `strat.split(text, combo.params)` + `assemble(...)`, counts tokens, embeds contents in a thread, and bulk-inserts `Chunk` rows with vectors (run_pipeline.py:205-236). Files producing no chunks are skipped (run_pipeline.py:212-213). Chunk/embed timings and totals are accumulated; this phase fills 0.0–0.5 of the combo bar (run_pipeline.py:239).
- Inside a combo — retrieve→judge→score (second half): status flips to `evaluating`, then for each QA pair it retrieves top-k via `retrieve(session, combo.id, qvec, top_k)`, saves a `Retrieval` (chunk ids, scores, latency), calls the LLM `judge`, saves a `JudgeEvaluation` (relevance/faithfulness/precision/recall + token counts), and computes per-query metrics against the gold passage with `M.compute_for_query` (run_pipeline.py:242-294). This phase fills 0.5–1.0 of the combo bar.
- Aggregate: it writes one `CombinationStats` (chunk/token totals, avg tokens, embedding+judge+total cost via `embedding_cost`/`groq_cost`, and chunk/embed/eval latencies) and one `Metrics` row — LLM scores are simple means over judged pairs, while precision@k/recall@k/MRR/nDCG@k/F2 come from `M.macro_average` over per-query results, plus mean retrieval latency (run_pipeline.py:298-331). The combo is then marked `completed` at progress 1.0 (run_pipeline.py:332-335).
- Progress fan-out: every stage publishes through `app.workers.progress` — `emit_run`/`emit_combo`/`emit_file`/`emit_log` push events to Redis (pub/sub for live SSE plus a snapshot for late joiners) and denormalize status/progress onto the DB rows, so both the SSE stream and REST polling stay consistent (progress.py:1-62).
- Error handling: the whole body is wrapped in one try/except — any exception logs the traceback, sets `run.status='failed'` with `run.error=str(exc)`, and emits a `failed` run event preserving the last `progress` plus an error-level log (run_pipeline.py:173-179). Note `_process_combination` has no inner try/except, so a single failing combo aborts the entire run.

```
run_pipeline(run_id)
  set run=running, pct=0
  load combos + files (_load_files)
  parse each file ONCE  -> parsed_map   (_ensure_parsed, deletes raw upload)
  generate QA set ONCE  -> qa_records    (gold passage + offsets)
  embed questions ONCE  -> q_vectors
  for each combo:                         _process_combination
    [chunking  | 0.0 -> 0.5]  per file: split -> assemble -> count -> embed -> insert Chunk
    [evaluating| 0.5 -> 1.0]  per QA:   retrieve top-k -> Retrieval -> judge -> JudgeEvaluation -> QueryMetrics
    aggregate -> CombinationStats + Metrics ; combo=completed(1.0)
    run.progress = (i+1)/total
  run=completed(1.0)        [any exception -> run=failed, error saved]
  (every step: progress.emit_* -> Redis pub/sub + DB denorm)
```

**In one line:** `run_pipeline` orchestrates the entire experiment in one arq task — parse files and build a shared QA set once, then for each chunking combination chunk/embed/store and retrieve/judge/score against that set, aggregating cost and accuracy metrics while streaming progress and failing the whole run on any error.


## 10. Progress — Redis pub/sub + snapshot → SSE

*Backend core*


> Worker progress is dual-written to Redis (pub/sub for live push + a snapshot hash for late joiners) and denormalized onto DB rows, then streamed to the browser over Server-Sent Events.

- Dual write on every event: `publish_progress` does both `r.publish(channel)` for live push and `r.hset(state_key, field, payload)` for a snapshot, with a 24h TTL via `expire` (redis.py:30-37). Channel is `run:{id}:progress`, snapshot hash is `run:{id}:state` (redis.py:22-27).
- Snapshot is keyed for last-write-wins: the hash field is `event.get('key') or event.get('type','event')`, so events with stable keys (e.g. `combo:{id}`, `file:{combo}:{file}`, `run`) overwrite prior state instead of piling up; `get_state` returns the current value of each field (redis.py:35-36, 40-43).
- Event shapes come from `workers/progress.py`: `emit_run` (type `run`, key `run`), `emit_combo` (key `combo:{id}`), `emit_file` (key `file:{combo}:{file}`), and `emit_log` (key `log:{seq}` using a module-global counter, so logs accumulate rather than overwrite) (progress.py:19-62).
- DB denormalization is separate from Redis: `set_run_status` and `set_combo_status` write `status`/`progress` directly onto `Run`/`RunCombination` rows and commit, so REST polling and post-hoc reads stay correct without Redis (progress.py:65-84).
- REST snapshot endpoint `GET /runs/{id}/progress` reads authoritative status/progress from the DB `Run` row plus the Redis event list via `get_state`, 404ing if the run is missing (progress.py:18-29).
- SSE endpoint `GET /runs/{id}/progress/stream` first replays the full Redis snapshot so a late joiner sees current state, then subscribes to the pub/sub channel for live updates (progress.py:32-44).
- The SSE loop polls `pubsub.get_message(timeout=1.0)`; on no message it emits a `ping` event (keepalive), and it breaks out when the client disconnects (`request.is_disconnected()`) or when a `run` event with a terminal status (`completed`/`failed`/`canceled`) arrives, then unsubscribes and closes (progress.py:46-64).
- Frontend `useRunProgress(runId, enabled)` opens a native `EventSource` to `progressStreamUrl(runId)`, gated by `enabled`, and reduces events into `{ runStatus, runPct, combos, files, logs, connected }`; `connected` flips on `onopen`/`onerror` (useRunProgress.ts:29-35).
- Client reducer mirrors the keying scheme: `combo` events index by `comboId`, `file` by `ev.key`, `log` is appended and capped at the last 40, and the client closes the `EventSource` itself once `runStatus` is terminal (useRunProgress.ts:43-63).

```
worker emit_*()                      browser
   |                                   |
   v  publish_progress()               | EventSource(progressStreamUrl)
 +----------------------+              v
 | Redis                |        GET /runs/{id}/progress/stream
 |  PUBLISH run:{id}:progress  --->  1) replay get_state() snapshot
 |  HSET    run:{id}:state(24h)      2) subscribe channel -> live msgs
 +----------------------+              |  (ping every 1s idle)
   |  (separate path)                  v
   v  set_run/combo_status()    useRunProgress reducer
 Postgres Run/RunCombination    -> {runStatus,runPct,combos,files,logs}
 rows  <--- GET /runs/{id}/progress (DB status + snapshot events)
```

**In one line:** Progress events are published to a Redis pub/sub channel and mirrored to a per-field snapshot hash (and denormalized onto DB rows), so the SSE stream can replay current state to late joiners then push live updates that the EventSource hook reduces into UI state.


## 11. Evaluation — QA gen, retrieve, judge, metrics

*Pipeline & eval*


> For each chunking combination, chunklab auto-generates a shared QA set with gold passages, retrieves top-k chunks by pgvector cosine, scores them with an LLM judge (4 subjective dims) and computes objective IR metrics (P@k/recall/MRR/nDCG/F2) against the gold passage.

- QA set is generated ONCE per run and shared across all combinations so comparisons are fair (run_pipeline.py:127-153). `_sample_passages` slices the doc text into up to N evenly-spaced 900-char windows (qa_generator.py:29-44); each window is sent to Groq via `QA_GENERATOR_PROMPT` (prompt_texts.py:3-13) which returns strict JSON `{question, reference_answer}`. The passage span (start/end offsets + text) is retained as the GOLD context for metrics (qa_generator.py:63-73).
- Question vectors are precomputed in a thread with `embed_texts` (run_pipeline.py:153). Retrieval is pure pgvector cosine: `Chunk.embedding.cosine_distance(query_vector)` ordered ascending, limited to k, scoped to a single combination (retriever.py:26-32). `relevance` is reported as `max(0, 1 - distance)` rounded to 4dp (retriever.py:39).
- The LLM judge scores subjective quality. Contexts are numbered `[1]..[k]` and packed with question + reference answer into the user message (judge.py:32-37), then graded 0.0-1.0 on FOUR dimensions via `JUDGE_PROMPT`: relevance, faithfulness, context_precision, context_recall, plus a short feedback string (prompt_texts.py:16-27, judge.py:49-56). All scores pass through `_clamp` to [0,1] and feedback is truncated to 500 chars (judge.py:24-28, 54).
- Objective IR metrics are computed independently of the judge against the gold passage. A retrieved chunk counts relevant only if it is from the SAME file AND its lowercased word-set overlaps the gold passage by >= 0.5 (`RELEVANCE_THRESHOLD`), with gold passages of <5 words skipped (metrics.py:17, 24-32, 51).
- Because there is exactly ONE gold passage per question, recall is binary (1.0 if any hit else 0.0), MRR is the reciprocal of the first hit's rank, precision is hits/k, nDCG normalizes DCG against an ideal of `min(num_relevant, k)` hits ranked first, and F2 weights recall over precision (metrics.py:57-72).
- Per-query metrics are macro-averaged across all questions for the final combination scores (metrics.py:83-93, run_pipeline.py:316). The 4 judge dimensions are separately averaged with `fmean` over all judged questions (run_pipeline.py:320-323).
- Each step is persisted: `QAPair` (question + gold passage), `Retrieval` (retrieved chunk ids, per-chunk relevance scores, latency_ms), `JudgeEvaluation` (4 dims + feedback + judge model + token usage) and aggregate `Metrics` + `CombinationStats` (run_pipeline.py:139-149, 259-283, 301-331).
- Resilience is built in: QA generation and judging both catch all exceptions and skip/return empty defaults rather than failing the run (qa_generator.py:54-56, judge.py:42-44). Judge token usage feeds the real Groq cost in the stats rollup (run_pipeline.py:270-271, 300).
- All LLM access goes through `get_llm().extract(...)` and JSON is parsed via `parse_json` (qa_generator.py:52-53, judge.py:40-41); prompts live only in `prompt_texts.py`, per project conventions.

```
doc text
   |  _sample_passages (N x 900-char windows)
   v
QA_GENERATOR_PROMPT (Groq) --> {question, reference_answer} + gold span (QAPair)
   |
   |  embed question (bge-small, 384d)
   v
per combination:
   retrieve top-k  --(pgvector cosine, relevance=1-distance)-->  k chunks (Retrieval)
        |                                   |
        v                                   v
   JUDGE_PROMPT (Groq)              metrics.compute_for_query
   relevance / faithfulness /        (gold-passage word overlap >=0.5,
   context_precision / recall         same file)
   (JudgeEvaluation)                 P@k / recall / MRR / nDCG@k / F2
        |                                   |
        +------------- macro/fmean ---------+
                          v
                    Metrics + CombinationStats
```

**In one line:** Per chunking combination, a shared LLM-generated QA set drives pgvector cosine retrieval, then results are scored both subjectively by a 4-dimension Groq judge and objectively by gold-passage IR metrics (P@k, recall, MRR, nDCG@k, F2), macro-averaged into per-combination Metrics.


## 12. Reporting & analytics (the read side)

*Read side*


> A single per-combination join (build_run_report) is the canonical read shape that every results, analytics, and cross-run endpoint reuses.

- `build_run_report(session, run_id)` is the one read-side primitive: it selects `RunCombination` and LEFT-joins `Metrics` and `CombinationStats` on `combination_id`, ordered by `RunCombination.label` (reporting.py:16-24). Outer joins mean a combo with no stats/metrics yet still appears, just zero-filled.
- Every numeric field is null-safe: missing stats default to 0/0.0 and `_f()` coerces `None`->0.0 (reporting.py:12-13, 36-55), so partially-completed runs never break the response shape.
- Each report row flattens three concerns into one dict: identity/status (`combination_id`, `label`, `strategy`, `params`, `status`), cost/tokens/latency from `CombinationStats` (chunk_count, total_tokens, embedding/judge/total cost, chunk/embed/eval latency), and accuracy from `Metrics` (relevance, faithfulness, context_precision/recall, precision/recall@k, mrr, ndcg_at_k, f2, avg_retrieval_latency_ms) (reporting.py:28-56).
- `GET /runs/{run_id}/results` 404s if the run is missing, then returns run header fields (`name`, `status`, `top_k`) plus `combinations: build_run_report(...)` (results.py:15-26). `GET /runs/{run_id}/analytics/compare` returns essentially the same payload minus the header (analytics.py:14-19).
- `GET /combinations/{combination_id}/chunks` is a separate paginated read straight off the `chunks` table (id, file_id, chunk_index, content, token_count, char_count), ordered by file_id then chunk_index, with `limit` hard-capped at 200 via `min(limit, 200)` and an `offset` (results.py:29-54).
- `GET /runs/{run_id}/qa-pairs` reads the shared QA set for a run from `QAPair`, returning question + reference_answer per row (results.py:57-70).
- `GET /runs/{run_id}/analytics/tradeoff` reshapes the same report into scatter-plot points, hardcoding `cost=total_cost_usd`, `accuracy=ndcg_at_k`, plus latency_ms and tokens (analytics.py:22-39) — nDCG@k is the canonical accuracy axis on the read side.
- `GET /projects/{project_id}/analytics/runs` is the cross-run rollup: it loads all runs for a project (newest first), calls `build_run_report` per run, picks the best combo by `max(... key ndcg_at_k)`, and aggregates `total_cost_usd` (rounded to 6dp) and `total_tokens` across combos (analytics.py:42-68).
- The read side is purely SQL reads with no recomputation — all metrics/stats are written by the worker pipeline; these endpoints only join and reshape, which is why they're thin and fast.

```
                  build_run_report(run_id)
                          |
   RunCombination --LEFT JOIN-- Metrics
                 \--LEFT JOIN-- CombinationStats
                          |
              list[dict]  (one per combination)
              /        |         \         \
   /runs/{id}/results  compare   tradeoff   projects/{id}/analytics/runs
   (+header,top_k)     (raw)     (scatter:  (per-run best ndcg +
                                  cost vs    summed cost/tokens)
                                  ndcg)

   separate reads (no join):
     /combinations/{id}/chunks  -> chunks table (paginated, cap 200)
     /runs/{id}/qa-pairs        -> qa_pairs table
```

**In one line:** The read side centers on build_run_report, a null-safe outer join of combinations + metrics + stats that results and analytics endpoints reshape into per-combination detail, cost/accuracy tradeoff points, and cross-run summaries, alongside direct paginated reads of chunks and QA pairs.


## 13. Chat / RAG over results

*Read side*


> A scope-aware RAG chatbot that grounds a Groq LLM in your experiment's report tables plus retrieved chunk snippets, streaming the answer back token-by-token.

- `POST /chat/stream` (chat.py:16) takes a `ChatRequest` with a `scope` of `project`, `run`, or `compare` (schema.py:13), a `message`, and prior `history`; it validates that each scope has its required id(s) (`run_id`, two `run_ids`, or `project_id`) before doing any work (chat.py:22-27), and is rate-limited to 30/minute (chat.py:17).
- Context is assembled by `build_context` (context_builder.py:61) per scope: `run` emits that run's report table + top-5 snippets (context_builder.py:71-74); `compare` emits report tables + 3 snippets each for the first two runs (context_builder.py:76-81); `project` pulls the 5 most recent completed runs' report tables plus snippets from the newest one (context_builder.py:83-96).
- Report tables come from `build_run_report` and are rendered as pipe-delimited Markdown over a fixed column set (tokens, cost$, relevance, faithfulness, P@k, recall, mrr, ndcg, f2) via `_format_report` (context_builder.py:14-36) — this is the structured analytics half of the RAG context.
- Snippets are retrieved live against the run's best combination, chosen by highest `ndcg_at_k` (`_best_combination_id`, context_builder.py:39-47); the user's question is embedded with `embed_query` and run through pgvector cosine `retrieve` for top-k chunks, each truncated to 500 chars (`_retrieve_snippets`, context_builder.py:50-58).
- If nothing is available the context falls back to the literal string `(no run results available yet)` (context_builder.py:98), so the model always receives a well-formed prompt.
- `stream_answer` builds the message list as a system turn of `CHAT_SYSTEM_PROMPT` + the injected `CONTEXT`, the last 8 history turns, then the new user message (chat_service.py:12-16), and streams at `temperature=0.3` via `get_llm().stream_chat` (chat_service.py:18-19).
- The LLM is the shared `GroqProvider` singleton from `get_llm()` (llm.py:86-92); `stream_chat` opens a streaming Groq completion and yields only non-empty `delta.content` deltas (llm.py:69-80), with the SDK configured for up to 6 retries to ride out 429 rate limits (llm.py:34).
- The router wraps that async generator in a FastAPI `StreamingResponse` with media type `text/plain; charset=utf-8` (chat.py:39-43), so the frontend consumes raw token text via `fetch` + `ReadableStream` rather than SSE.
- The prompt lives only in `app/prompts/prompt_texts.py` as `CHAT_SYSTEM_PROMPT` (prompt_texts.py:30), framing the model as "chunklab's analyst assistant" per the project's prompt-centralization convention.

```
POST /chat/stream {scope, ids, message, history}
        |
        v
  build_context(scope) ----------------------------+
   |  report tables (build_run_report -> Markdown)  |
   |  snippets: best combo (max ndcg) ->            |
   |    embed_query -> pgvector cosine retrieve(k)   |
        |                                            |
        v                                            |
  stream_answer: [system = CHAT_SYSTEM_PROMPT+CONTEXT]
                 + history[-8:] + user message
        |
        v
  GroqProvider.stream_chat (temp=0.3, stream=True)
        |
        v
  StreamingResponse  text/plain  -->  browser ReadableStream
```

**In one line:** Chat injects scope-specific report tables and freshly retrieved chunk snippets into a Groq system prompt and streams a grounded answer back as plain-text tokens over POST /chat/stream.


## 14. Frontend architecture

*Frontend*


> How the Next.js client is wired: a single typed API wrapper, a clean split between TanStack Query (server state) and Zustand (draft builder state), a strategy catalog that mirrors the backend, an SSE progress hook, and a batched browser logger.

- Single API surface: every backend call goes through `src/lib/api.ts`, which derives `API_BASE` from `NEXT_PUBLIC_API_BASE_URL` (default `http://localhost:8000`) and `V1 = ${API_BASE}/api/v1` (api.ts:12-14). The internal `req<T>()` sets JSON headers, throws `Error(body.detail \|\| statusText)` on non-2xx, and returns `undefined` for HTTP 204 (api.ts:16-33). One typed function per endpoint (`listProjects`, `getRun`, `getResults`, `getTradeoff`, etc.).
- Two calls deliberately bypass `req`: `uploadFile` uses raw `XMLHttpRequest` (not fetch) to get real `xhr.upload.onprogress` events, posting a `FormData` with field name `upload` plus `parser`/`ocr`/`tables` parse options (api.ts:53-83); `chatStream` returns the raw `Response` so the caller can read `response.body` as a token stream (api.ts:141-147).
- State is split by origin: server-derived data lives in TanStack Query, configured once in `providers.tsx` with `refetchOnWindowFocus: false` and `retry: 1` (providers.tsx:8-13). Ephemeral run-builder draft state lives in Zustand `useBuilderStore` — `combos: DraftCombination[]` with `add` (returns `false` on duplicate `label`), `remove(label)`, `clear()` (builder-store.ts:11-20). Dedup is purely by `label`, so drafts must be labeled via `buildLabel`.
- `src/lib/strategies.ts` is the UI source of truth that must mirror the backend chunking registry: `STRATEGIES` lists the five strategies (`sentence`, `character`, `recursive`, `token`, `semantic`) with their param fields, mins, maxes, and defaults (strategies.ts:17-69). Param keys must match the backend (`size`/`overlap`, `chunk_size`/`overlap`, `breakpoint_percentile`).
- `buildLabel(strategy, params)` reproduces the backend `label()` output exactly — e.g. `sentence·{size}/{overlap}`, `recursive·{chunk_size}/{overlap}`, `semantic·pct{breakpoint_percentile}` (strategies.ts:76-91). The separator is `·` (middle dot), not an ASCII dot; labels drive both display and dedup, so any drift breaks de-duplication and result joins.
- Live progress uses native `EventSource`, not fetch: `useRunProgress(runId, enabled)` opens an SSE connection to `progressStreamUrl(runId)` (= `.../runs/{id}/progress/stream`, api.ts:129-130) and reduces the `ProgressEvent` union into `{ runStatus, runPct, combos, files, logs, connected }` (useRunProgress.ts:18-67). It auto-closes the stream when status is terminal (`completed`/`failed`/`canceled`, useRunProgress.ts:16,48) and caps `logs` at the last 40 entries (useRunProgress.ts:57).
- `ProgressEvent` is a discriminated union with four `type`s — `run`, `combo`, `file`, `log` — defined in `types.ts:116-120`, keyed by `comboId`/`key`; `types.ts` is the shared contract for all API/domain shapes (`Run`, `ReportRow`, `TradeoffPoint`, `DraftCombination`, etc.) and is meant to track the backend Pydantic schemas.
- `src/lib/logger.ts` is a client-only batched logger: `emit` color-codes to the console and pushes events into a buffer; `warn`/`error` flush immediately while `info`/`debug` batch on a 2.5s timer, POSTing to `/api/v1/logs` with `keepalive: true` (logger.ts:24-50). `installGlobalLogging()` (called from `providers.tsx:15-16`) hooks `window.error`, `unhandledrejection`, and `beforeunload`.
- `src/lib/format.ts` holds pure display helpers — `formatTokens`/`formatCost`/`formatMs`/`formatPct` and `statusColor(status)` which maps run/file statuses to Tailwind badge classes (format.ts:1-44).

```
Component
  |
  |-- useQuery/useMutation -----> lib/api.ts (req<T>) --HTTP--> /api/v1/*   [server state: TanStack Query]
  |-- useBuilderStore (Zustand) ----------------------------> draft combos  [client-only matrix]
  |-- useRunProgress(runId) --EventSource--> /runs/{id}/progress/stream --> {run,combo,file,log}
  |-- chatStream() --fetch+ReadableStream--> /chat/stream (token stream)
  |
  strategies.ts (STRATEGIES + buildLabel)  <== must mirror ==>  backend chunking registry
  logger.ts (batched) --POST keepalive--> /api/v1/logs
```

**In one line:** The Next.js frontend funnels all backend traffic through one typed `api.ts` wrapper, keeps server data in TanStack Query and only ephemeral builder drafts in Zustand, mirrors the backend strategy/label registry in `strategies.ts`, streams live run progress via a native-EventSource hook, and ships batched client logs to the backend.


## 15. The builder → progress → dashboard UI flow

*Frontend*


> How the frontend walks a user from assembling a chunking-strategy matrix, to watching a run execute live over SSE, to exploring scored results, charts, and a grounded chat.

- Builder (`runs/new/page.tsx`): the user picks one strategy + numeric params (`pickStrategy`/`params` state, page.tsx:34-38), clicks 'Add to matrix' which calls `buildLabel` + `useBuilderStore.add` (page.tsx:40-43) — the draft matrix lives in Zustand, deduped by `label`. File scope is 'all parsed files' or a hand-picked subset (page.tsx:28-29,45), and `parsedFiles` is filtered to `status === 'parsed'` (page.tsx:32). 'Total chunking jobs' = `combos.length * fileCount` (page.tsx:46).
- Launch (`runs/new/page.tsx`:48-64): `createRun` posts `{name, top_k, qa_per_file, max_qa, combinations, file_ids}` where `file_ids` is `'all'` or the selected id array; on success it clears the Zustand store and `router.push`es to the run-detail page. The button is disabled when the matrix is empty, no files match, or the mutation is pending (page.tsx:242).
- Files (`files/page.tsx`): uploads run sequentially through `uploadFile` with a per-file progress callback (page.tsx:54-71) and parsing options chosen up front — parser `docling` vs `fast`, plus `ocr`/`tables` toggles for docling (page.tsx:38-40,149-163). The file list `useQuery` self-polls every 2s while any file is `uploaded`/`parsing` (page.tsx:45-46), so parse status updates without manual refresh; deletes invalidate the `['files', projectId]` key.
- Run detail (`runs/[runId]/page.tsx`): a `getRun` query polls every 2s only while status is `queued`/`running` (page.tsx:23). When `active` it renders `<RunProgress>`; otherwise it shows a tab bar — Analytics / QA set / Chat (page.tsx:69-104). A 'Compare' link appears only when the run is `completed` and another completed run exists (page.tsx:53-60).
- Live progress (`RunProgress.tsx` + `useRunProgress.ts`): `useRunProgress(runId, true)` opens a native `EventSource` to `progressStreamUrl(runId)` and reduces typed `ProgressEvent`s into `{runStatus, runPct, combos, files, logs, connected}` (useRunProgress.ts:29-64). The stream auto-closes when run status is terminal (`completed`/`failed`/`canceled`, useRunProgress.ts:16,48) and logs are capped at the last ~40 (useRunProgress.ts:57).
- RunProgress merges two sources: live SSE state plus a `getCombinations` query that polls every 3s as a fallback (RunProgress.tsx:12-16). Per-combination rows prefer live values and fall back to the polled snapshot — `status = liveCombo?.status \|\| c.status`, `cpct = liveCombo?.pct ?? c.progress` (RunProgress.tsx:42-44) — and the overall bar uses `live.runPct \|\| overallPct` (RunProgress.tsx:17). A 'live' pulse badge shows only while `connected` (RunProgress.tsx:26).
- Dashboard (`ResultsDashboard.tsx`): one `getResults(runId)` query feeds everything (ResultsDashboard.tsx:51). It derives winner StatCards (best nDCG, lowest cost, fastest retrieval, best accuracy/$ via `ndcg/cost`, ResultsDashboard.tsx:57-64), a Recharts accuracy bar chart, a cost-vs-accuracy scatter where bubble size = latency (ResultsDashboard.tsx:90-125), and a per-metric table that bolds + stars the column-max (ResultsDashboard.tsx:157-166). An amber banner warns when all accuracy metrics are zero (likely the Groq judge failed), and a CSV export is built client-side (ResultsDashboard.tsx:35-48,76-81).
- MetricsInfo (`MetricsInfo.tsx`): a static modal documenting the eight metrics, tagging each as `Computed` (precision@k, recall@k, MRR, nDCG@k, F2 — from the gold passage, no LLM) or `LLM judge` (relevance, faithfulness, context_precision, context_recall — scored by Groq), noting the QA set is shared across combinations so scores are comparable (MetricsInfo.tsx:13-68,124-128).
- Chat (`ChatPanel.tsx`): not EventSource — it calls `chatStream(payload)` and reads `response.body` with a `ReadableStream` reader + `TextDecoder`, appending decoded text to the in-progress assistant message (ChatPanel.tsx:57-72). Scope is `project \| run \| compare`, attaching `project_id` plus `run_id`/`run_ids` accordingly (ChatPanel.tsx:54-56); the run-detail tab uses `scope='run'` with `RUN_SUGGESTIONS` (page.tsx:95-103). Chat history is local component state, not persisted.

```
runs/new (Zustand draft matrix)
  pick strategy+params -> Add to matrix (buildLabel/dedup)
  choose files (all | subset of status=parsed)
        | createRun({combinations, file_ids})  -> router.push
        v
runs/[runId]  (getRun poll @2s while queued/running)
  active? --yes--> RunProgress
  |                 EventSource(progress/stream) -> useRunProgress
  |                 + getCombinations poll @3s (fallback)
  |                 overall bar + per-combo rows + activity log
  |
  no (completed/failed) --> tabs:
        [Analytics] ResultsDashboard  (getResults: StatCards,
                                       bar + cost/acc scatter, table, CSV)
        [QA set]    QASet
        [Chat]      ChatPanel (fetch + ReadableStream token stream)
```

**In one line:** The run-detail page is a state machine: build a deduped matrix in Zustand and launch, watch a 2s-polled run flip into a live SSE progress view, then on completion swap to tabbed results (Recharts dashboard, QA set, and a stream-read chat).


## 16. CI, Docker images, docs & ops

*Ops*


> How chunklab is gated on every push, packaged into runnable images, throttled and observed at runtime, and documented for developers.

- CI is a single GitHub Actions workflow with two parallel jobs (`.github/workflows/ci.yml:8-41`) triggered on push to `main` and any pull_request (`ci.yml:3-6`). The `backend` job installs `uv`, runs `ruff check backend/app backend/tests` (`ci.yml:20-23`), then runs only the no-services unit subset: test_config, test_chunking, test_metrics, test_pricing_jsonutil (`ci.yml:25-27`). It deliberately installs just a minimal dep set (`pydantic, pydantic-settings, pytest, pytest-asyncio`, `ci.yml:18-19`), so heavy deps (torch/docling/groq) are never pulled in CI.
- The `frontend` CI job runs in `frontend/` on Node 22, doing `npm install` then `npm run build` (`ci.yml:29-40`) — a build smoke test, no separate lint/test step.
- Backend image (`Dockerfile.backend`) is a single image shared by both the API and the arq worker, differing only by command — compose runs the same build for `backend` and `worker`, overriding the worker's CMD to `arq app.workers.settings.WorkerSettings` (`docker-compose.yml:60-66`). It installs CPU-only torch/torchvision from the PyTorch CPU index to avoid the multi-GB CUDA build, then force-reinstalls the matched pair after requirements so docling's `torchvision::nms` resolves (`Dockerfile.backend:14-26`). App code is run via `PYTHONPATH=/app/backend` with no packaging step (`Dockerfile.backend:28-30`); HF/FastEmbed model caches live under `/root/.cache` (`Dockerfile.backend:32-33`) and are mounted as a shared `hf_cache` volume so backend+worker reuse downloaded models (`docker-compose.yml:48,73`).
- Frontend image (`Dockerfile.frontend`) is a two-stage Next.js standalone build: stage `build` runs `npm run build`, stage `run` copies only `.next/standalone`, `.next/static`, and `public` and starts `node server.js` (`Dockerfile.frontend:2-24`). `NEXT_PUBLIC_API_BASE_URL` is a build ARG inlined at build time (`Dockerfile.frontend:11-12`); compose passes `http://localhost:8001` so the browser hits the host-exposed backend port (`docker-compose.yml:87-88,40`).
- Rate limiting uses slowapi in-memory per-process (`backend/app/core/ratelimit.py:12`) with a global default of `600/minute` keyed by remote address. It's wired in `main.py` via `app.state.limiter`, the `RateLimitExceeded` handler, and `SlowAPIMiddleware` (`main.py:48-50`). Expensive endpoints add stricter per-route limits: chat `30/minute` (`chat.py:17`), runs `30/minute` (`runs.py:21`), file uploads `120/minute` (`files.py:22`). Note: in-memory storage only protects a single instance (`ratelimit.py:10-11`).
- Request logging is a custom HTTP middleware (`main.py:63-83`) that times every request and logs to the `access` logger at info for 2xx/3xx, warning for 4xx, error/exception for 5xx; `/health` is explicitly skipped to keep healthcheck noise out (`main.py:65-66`). The compose backend healthcheck polls `/health` (`docker-compose.yml:55`).
- Client-side telemetry flows back to the server: `POST /api/v1/logs` (`api/routers/logs.py:24`) accepts a batch of `ClientEvent`s (level/event/detail/path) and re-emits each through the backend `client` logger at the matching level (`logs.py:34-42`), so UI actions/errors appear in `docker compose logs backend`.
- Docs live in `docs/` as a mix of Markdown references and prebuilt HTML walkthroughs. Markdown set: ARCHITECTURE, DATA_MODEL, CHUNKING, EVALUATION, API, SETUP, SECURITY, DECISIONS (indexed in `README.md:59-67`); plus HTML guides (overview, implementation, evaluation, chunking_strategies, ER diagram, and a Redis architecture series). Secret handling policy is in `docs/SECURITY.md` — the real Groq key lives in a gitignored `.env` copied from `.env.example`.

```
push / PR
   |
   v
.github/workflows/ci.yml
 ├── backend  : uv + ruff check + pytest (config/chunking/metrics/pricing)
 └── frontend : node22 + npm install + npm run build

docker compose up --build
 ├── Dockerfile.backend  → image used by BOTH:
 │      backend (uvicorn :8000)   worker (arq WorkerSettings)
 │      └─ shared hf_cache volume (models)
 └── Dockerfile.frontend → next standalone → node server.js :3000

runtime request → SlowAPIMiddleware (600/min default; route limits)
                → log_requests middleware (access logger, skips /health)
browser events  → POST /api/v1/logs → backend "client" logger
```

**In one line:** chunklab gates pushes with a lightweight two-job GitHub Actions workflow, ships one shared backend image (API + worker) plus a standalone Next.js image via docker compose, and runs with slowapi rate limiting, access/client logging middleware, and a Markdown+HTML docs set under `docs/`.


## Appendix A — Chunking strategies, real output

Each strategy run on the same sample text in the live backend.


| Strategy | unit | #chunks | note |
|---|---|---|---|
| `character·200/40` | characters | 5 | Fixed char windows; cuts mid-word. Deterministic baseline. |
| `recursive·200/40` | characters | 5 | Targets a size but breaks on natural separators (paragraph→line→word). |
| `sentence·64/0` | tokens | 3 | Packs whole sentences toward a token target; never splits a sentence. |
| `token·48/8` | tokens (exact) | 4 | Exact token windows in the embedder's own tokens (note wordpiece artifacts). |
| `semantic·pct80` | variable (by topic) | 3 | Splits where the topic shifts; sizes vary, found by embedding similarity. |

**`character·200/40`** — 5 chunks (characters)

| # | chars | tokens | content |
|---|---|---|---|
| 0 | 200 | 38 | Retrieval-augmented generation grounds a language model in your own documents. Instead of relying only on what the model memorized, it retrieves relevant passages at query time. Th… |
| 1 | 200 | 39 | es at query time. The quality of that retrieval depends heavily on how the documents were split into chunks. Chunks that are too large dilute relevance and waste the context window… |
| 2 | 200 | 39 | e the context window. Chunks that are too small lose the surrounding context an answer needs.  Vector databases store each chunk as a high-dimensional embedding. At query time the … |
| 3 | 200 | 40 | . At query time the question is embedded and the nearest chunks are returned by cosine similarity. An approximate index such as HNSW keeps this search fast even over millions of ve… |
| 4 | 124 | 21 |  over millions of vectors. Choosing the right chunking strategy is therefore the single biggest lever on retrieval accuracy. |

**`recursive·200/40`** — 5 chunks (characters)

| # | chars | tokens | content |
|---|---|---|---|
| 0 | 197 | 37 | Retrieval-augmented generation grounds a language model in your own documents. Instead of relying only on what the model memorized, it retrieves relevant passages at query time. Th… |
| 1 | 198 | 38 | at query time. The quality of that retrieval depends heavily on how the documents were split into chunks. Chunks that are too large dilute relevance and waste the context window. C… |
| 2 | 91 | 17 | the context window. Chunks that are too small lose the surrounding context an answer needs. |
| 3 | 197 | 41 | Vector databases store each chunk as a high-dimensional embedding. At query time the question is embedded and the nearest chunks are returned by cosine similarity. An approximate i… |
| 4 | 185 | 34 | An approximate index such as HNSW keeps this search fast even over millions of vectors. Choosing the right chunking strategy is therefore the single biggest lever on retrieval accu… |

**`sentence·64/0`** — 3 chunks (tokens)

| # | chars | tokens | content |
|---|---|---|---|
| 0 | 268 | 49 | Retrieval-augmented generation grounds a language model in your own documents. Instead of relying only on what the model memorized, it retrieves relevant passages at query time. Th… |
| 1 | 309 | 60 | Chunks that are too large dilute relevance and waste the context window. Chunks that are too small lose the surrounding context an answer needs.  Vector databases store each chunk … |
| 2 | 185 | 34 | An approximate index such as HNSW keeps this search fast even over millions of vectors. Choosing the right chunking strategy is therefore the single biggest lever on retrieval accu… |

**`token·48/8`** — 4 chunks (tokens (exact))

| # | chars | tokens | content |
|---|---|---|---|
| 0 | 269 | 48 | retrieval - augmented generation grounds a language model in your own documents. instead of relying only on what the model memorized, it retrieves relevant passages at query time. … |
| 1 | 253 | 48 | on how the documents were split into chunks. chunks that are too large dilute relevance and waste the context window. chunks that are too small lose the surrounding context an answ… |
| 2 | 234 | 48 | chunk as a high - dimensional embedding. at query time the question is embedded and the nearest chunks are returned by cosine similarity. an approximate index such as hnsw keeps th… |
| 3 | 133 | 23 | fast even over millions of vectors. choosing the right chunking strategy is therefore the single biggest lever on retrieval accuracy. |

**`semantic·pct80`** — 3 chunks (variable (by topic))

| # | chars | tokens | content |
|---|---|---|---|
| 0 | 413 | 76 | Retrieval-augmented generation grounds a language model in your own documents. Instead of relying only on what the model memorized, it retrieves relevant passages at query time. Th… |
| 1 | 163 | 33 | Vector databases store each chunk as a high-dimensional embedding. At query time the question is embedded and the nearest chunks are returned by cosine similarity. |
| 2 | 185 | 34 | An approximate index such as HNSW keeps this search fast even over millions of vectors. Choosing the right chunking strategy is therefore the single biggest lever on retrieval accu… |

## Appendix B — Evaluation scores, real numbers

Gold passage: `An approximate index such as HNSW keeps vector search fast over millions of vectors.`


**Computed metrics — five retrieval outcomes (k=5)**

| Outcome | P@5 | recall@5 | MRR | nDCG@5 | F2 |
|---|---|---|---|---|---|
| Gold chunk ranked #1 (ideal) | 0.2 | 1.0 | 1.0 | 1.0 | 0.5556 |
| Gold chunk ranked #3 | 0.2 | 1.0 | 0.3333 | 0.5 | 0.5556 |
| Two relevant chunks at #1 and #2 | 0.4 | 1.0 | 1.0 | 1.0 | 0.7692 |
| Gold not retrieved at all (miss) | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| Right text but WRONG file | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |

**LLM judge — live Groq output**

- **Good context (on-topic, supports the answer)** — relevance=1.0, faithfulness=1.0, context_precision=1.0, context_recall=1.0 (273 in / 55 out tokens). Feedback: *The context directly answers the question with a clear and concise explanation.*
- **Bad context (off-topic, unrelated)** — relevance=0.0, faithfulness=0.0, context_precision=0.0, context_recall=0.0 (278 in / 54 out tokens). Feedback: *The context is completely unrelated to the question about vector search.*

## Appendix C — Architecture decisions (19)


### Monorepo: backend + frontend + infra + docs in one repository  
*Infra & ops*

**Chosen:** chunklab keeps the entire system in a single git repo with top-level dirs backend/ (FastAPI app), frontend/ (Next.js 15), infra/ (Postgres init SQL), and docs/. One root docker-compose.yml wires up all five services (postgres, redis, backend, worker, frontend); both Docker images build from the repo root (context: .) and the backend image is shared by the API and the arq worker. A single root pyproject.toml configures the Python toolchain (ruff/pytest pointed at backend/), and one CI workflow runs separate backend and frontend jobs against their subdirectories.

**Why:**
- API contract between backend and frontend churns during early dev; one repo lets a contract change ship as a single commit/PR instead of coordinated cross-repo PRs (docs/DECISIONS.md:17-22)
- docker-compose.yml at the root wires all services together with relative paths (./infra/postgres/init.sql, build context '.'), so one 'docker compose up --build' brings up the whole stack (docker-compose.yml:33-94, README.md:43)
- Backend and worker share the same image/codebase (Dockerfile.backend), which is only natural when they live in the same tree (docker-compose.yml:33-66, docs/ARCHITECTURE.md:30-34)
- Single-author, fast-moving v0.1 doesn't need independent per-component versioning or release cadence (docs/DECISIONS.md:39-40)
- One .gitignore and one security boundary (the gitignored .env at root) to reason about for both halves (docs/DECISIONS.md:38, CLAUDE.md Secrets section)

**Alternatives rejected:**
- *Polyrepo: separate backend and frontend git repositories* — Would force coordinating cross-repo PRs for every API contract change and maintaining version pins between the two, which DECISIONS.md explicitly rejects for a frequently-changing early-dev contract (docs/DECISIONS.md:20-22)
- *Formal monorepo tooling (Nx / Turborepo / pnpm workspaces)* — Not used: there is no workspace manifest or task-graph tool; orchestration is plain docker-compose plus a hand-written two-job GitHub Actions workflow, sufficient for one Python app + one Next.js app (.github/workflows/ci.yml:8-40, frontend/package.json)
- *Single shared language/toolchain across both halves (e.g. all-TypeScript or all-Python)* — Not chosen: the stack is deliberately polyglot — Python/FastAPI backend driven by root pyproject.toml and frontend Next.js/TypeScript with its own package.json, each with separate dependency files and Dockerfiles (pyproject.toml:1-64, frontend/package.json, Dockerfile.backend vs Dockerfile.frontend)
- *Co-locate frontend inside the backend app (served as static assets by FastAPI)* — Not done: frontend is its own service in compose on port 3000 with its own standalone Next.js image and Node server, talking to the backend over HTTP/SSE rather than being bundled and served by FastAPI (docker-compose.yml:83-94, Dockerfile.frontend:15-24, README.md:28-33)

### FastAPI fully-async backend (async I/O end to end)  
*Async & jobs*

**Chosen:** The backend is FastAPI with async I/O throughout. Every request handler and middleware is `async def`, the app uses an async `lifespan` to bootstrap the DB and create the arq Redis pool (main.py:35-45,63-92), and persistence runs on SQLAlchemy 2 async via `create_async_engine`/`async_sessionmaker` over the asyncpg driver (`postgresql+asyncpg://...`, config.py:22; engine.py:7-9). Sessions are yielded as request-scoped async dependencies and as an async context manager for workers/scripts (session.py:9-19). Heavy blocking CPU work is pushed off the event loop into threads via `asyncio.to_thread(...)` in the worker (run_pipeline.py:51,153,219).

**Why:**
- The whole I/O stack is concurrency-bound, not CPU-bound: pgvector queries, Groq LLM calls, and Redis pub/sub all benefit from a single event loop handling many in-flight awaits rather than thread-per-request blocking.
- It lets the API and the arq worker share the exact same `async def` code paths — async DB sessions (session.py), async LLM/embedding — with no sync/async bridging (this is the explicit rationale in DECISIONS.md ADR-003 for picking arq).
- SSE progress (`EventSource`) and chat token streaming (`ReadableStream` over `/chat/stream`) are long-lived streaming responses; async handlers stream tokens without tying up a worker thread per connection.
- FastAPI's async lifespan cleanly owns startup/shutdown: `init_db()` bootstrap and the shared arq pool on `app.state.arq`, closed on shutdown (main.py:38-42).
- `expire_on_commit=False` plus per-request async sessions (engine.py:9, session.py:9-12) give clean request-scoped transactions while keeping objects usable after commit in async flows.

**Alternatives rejected:**
- *Synchronous FastAPI/Flask with sync SQLAlchemy + psycopg, thread-per-request* — Would force sync wrappers around the already-async LLM, embedding, and arq layers; DECISIONS.md ADR-003 explicitly rejects sync models to avoid sync/async bridging, and the engine is built with create_async_engine + asyncpg (engine.py:7).
- *Run the heavy pipeline inline in async request handlers (no worker)* — Parsing/embedding/judging are long (run_pipeline job timeout is 1 hour) and CPU-blocking; running them in handlers would block the event loop and break request latency. The code instead enqueues to arq via app.state.arq and offloads CPU work with asyncio.to_thread (run_pipeline.py:51,153,219).
- *Django/DRF (predominantly sync ORM and views)* — Its sync-first ORM and request model conflict with the async-everywhere convention (async DB + async LLM/embedding); the team standardized on async SQLAlchemy 2 + asyncpg (engine.py, session.py).
- *Node/Express backend* — The chunking/embedding/eval logic and the worker are Python (FastEmbed, HF tokenizer, docling, Groq SDK); a Python async framework keeps API and worker on one shared codebase, which is the stated arq motivation (DECISIONS.md ADR-003).

### Background jobs via arq (asyncio Redis queue), not in request handlers  
*Async & jobs*

**Chosen:** Long-running work runs in a separate arq worker fed by a Redis queue. The arq pool is created once at API startup and stored on app.state.arq (main.py:39); routers inject it via Depends(get_arq) (deps.py:6-8) and call arq.enqueue_job("run_pipeline", run_id) / enqueue_job("parse_file_task", file_id) (runs.py:68, files.py:58), persisting the row as status="queued" and returning immediately. A worker container runs the same image with command ["arq","app.workers.settings.WorkerSettings"] (docker-compose.yml:66), executing run_pipeline / parse_file_task (settings.py:44) which are async def coroutines.

**Why:**
- The whole pipeline (parse, QA-gen, chunk, embed, retrieve, judge, aggregate) is long and multi-stage (run_pipeline.py:1-6) and cannot block an HTTP handler; create_run only writes rows and enqueues, then returns RunOut (runs.py:42-70).
- The backend is async end-to-end (async SQLAlchemy sessions via session_scope, async LLM/embedding); arq tasks are plain async def, so worker code runs the same async DB/LLM/embedding calls with no sync/async bridging (settings.py:44, run_pipeline.py:43-70).
- Redis is already in the stack and reused: it's the arq broker (REDIS_SETTINGS from REDIS_URL, settings.py:12) and also backs progress pub/sub, so the queue adds no new infrastructure.
- Worker and API share one Docker image and the hf_cache volume, so embeddings are warmed once in worker _startup (settings.py:15-19) and code/model cache are shared (docker-compose.yml:60-74).
- Crash-resilience is built in: worker _startup re-enqueues files stuck in 'uploaded'/'parsing' after a restart (settings.py:28-36), and job_timeout=3600 / max_jobs=4 bound runtime and concurrency (settings.py:47-48).

**Alternatives rejected:**
- *Run the pipeline inline in the request handler (FastAPI BackgroundTasks or just awaiting it)* — A run can take up to an hour (job_timeout=3600, settings.py:47); it would block/timeout the HTTP request, die with the request lifecycle, and not survive a restart the way the queued+re-enqueue self-heal does (settings.py:28-36).
- *Celery* — Celery's threading/multiprocessing worker model would force sync wrappers around the already-async SQLAlchemy/LLM/embedding code; arq's coroutines (async def run_pipeline) run that code natively (settings.py:44, run_pipeline.py:43).
- *RQ (Redis Queue)* — RQ forks sync worker processes and is not asyncio-native, so the async DB/LLM stack would again need sync bridging; arq was chosen specifically as an asyncio Redis queue (per ADR-003).
- *A dedicated broker like RabbitMQ / cloud queue (SQS)* — Redis is already present and reused for both the arq broker and progress pub/sub (settings.py:12); a separate broker would add infrastructure for no benefit at this scale.

### Realtime progress transport: SSE + Redis pub/sub + snapshot hash + DB denormalization  
*Realtime*

**Chosen:** Progress is dual-written: the worker calls publish_progress() which PUBLISHes each event JSON to Redis channel run:{id}:progress AND HSETs it (keyed by a stable event.key) into a snapshot hash run:{id}:state with a 24h TTL (backend/app/core/redis.py:30-37). The aggregate is also denormalized onto Run/RunCombination DB rows via set_run_status/set_combo_status (backend/app/workers/progress.py:65-84). The endpoint GET /runs/{id}/progress/stream returns an sse_starlette EventSourceResponse that first replays the snapshot hash (HGETALL) then subscribes to the pub/sub channel and forwards live messages, sending periodic ping events on idle and closing when a terminal run event arrives (backend/app/api/routers/progress.py:32-66). The frontend consumes it with the browser-native EventSource in useRunProgress, reducing run/combo/file/log events into UI state and auto-closing on terminal status (frontend/src/hooks/useRunProgress.ts:29-64). A plain GET /runs/{id}/progress returns the DB row status/progress plus the snapshot events for pollers (backend/app/api/routers/progress.py:18-29).

**Why:**
- Worker and API are separate processes (arq worker vs FastAPI); Redis pub/sub decouples the event producer from the SSE relay so the worker never holds an HTTP connection (backend/app/workers/progress.py:13,19-62).
- Progress is naturally one-directional server->client streaming of discrete events, which is exactly what SSE + native EventSource is built for; EventSource gives auto-reconnect for free, so no client retry logic is needed (frontend/src/hooks/useRunProgress.ts:31-35).
- Pub/sub alone loses events for late joiners; the per-field snapshot hash keyed by event.key lets a client that connects mid-run replay current state before live updates (backend/app/core/redis.py:34-36, backend/app/api/routers/progress.py:37-39).
- Denormalizing the aggregate onto Run/RunCombination rows makes progress durable beyond the pub/sub channel and the hash TTL, and gives a cheap REST polling/snapshot path with no streaming connection (backend/app/workers/progress.py:65-84, backend/app/api/routers/progress.py:18-29).
- Redis is already a hard dependency for the arq job queue, so reusing it for transport adds no new infrastructure (per ADR-003/ADR-010 in docs/DECISIONS.md:112).

**Alternatives rejected:**
- *WebSockets* — Bidirectional and heavier; progress is one-way server->client, so WS adds protocol/handshake complexity and loses the native EventSource auto-reconnect that the code relies on (frontend/src/hooks/useRunProgress.ts:31).
- *Plain REST polling only (no streaming)* — The denormalized GET /runs/{id}/progress path exists as a fallback, but polling alone gives coarse latency and repeated DB hits; SSE delivers per-event run/combo/file/log granularity in real time (backend/app/api/routers/progress.py:18-29 vs 32-66).
- *Direct in-process pub/sub / shared memory between worker and API* — Worker and API are distinct processes (arq vs uvicorn) and scale independently, so an out-of-process broker is required; Redis pub/sub provides exactly that (backend/app/workers/progress.py:13).
- *Redis Streams (XADD/XREAD) instead of pub/sub + hash* — Streams would give a persistent ordered log with consumer offsets, but the code instead uses ephemeral pub/sub for liveness plus a small current-state hash for catch-up, which is simpler and sufficient since per-key latest-value snapshot is all the UI needs (backend/app/core/redis.py:30-43).

### Vector store: Postgres + pgvector (not a dedicated vector DB)  
*Data & storage*

**Chosen:** chunklab stores embeddings as a `vector(384)` column on `results.chunks` in the same PostgreSQL instance that holds all relational metadata, and does similarity search as plain SQL cosine-distance KNN over an HNSW index. The `embedding` column is `mapped_column(Vector(EMBEDDING_DIM))` (models_results.py:35), `init_db()` runs `CREATE EXTENSION IF NOT EXISTS vector` and builds the HNSW index `embedding vector_cosine_ops (m=16, ef_construction=64)` (setup_db.py:24,32-35), and retrieval is a single `select(...).order_by(Chunk.embedding.cosine_distance(query_vector)).limit(k)` scoped by `combination_id` (retriever.py:26-32). No separate vector DB or external index is used.

**Why:**
- One datastore: embeddings live alongside their FKs (combination_id, file_id) on the same table (models_results.py:25-35), so a retrieval query can scope by combination and join metadata transactionally with no dual-write/sync problem
- Retrieval is ordinary SQL — `WHERE combination_id == ... ORDER BY cosine_distance LIMIT k` (retriever.py:29-32) — keeping the retriever a ~40-line function with no extra client/SDK
- pgvector is already the DB: DATABASE_URL points at one Postgres (config.py:22) and the pgvector/pgvector:pg16 image plus init.sql provision the extension, so adding vector search needs zero new infrastructure (init.sql:4, ARCHITECTURE.md:27,85)
- Workload fits pgvector's sweet spot: 384-dim vectors (EMBEDDING_DIM=384, config.py:19) at evaluation-tool data volumes, with HNSW giving fast approximate KNN that needs no training and supports incremental inserts during the pipeline (setup_db.py:29)
- Idempotent startup bootstrap (extension + schemas + create_all + index) means the whole vector store is stood up by one container with no migration or separate provisioning step (setup_db.py:22-37)

**Alternatives rejected:**
- *Dedicated vector DB (Pinecone / Qdrant / Weaviate / Milvus)* — Would add a second piece of infrastructure and a second consistency boundary that must be kept in sync with the relational rows; chunks already carry combination_id/file_id FKs (models_results.py:25-29) and need combination-scoped filtering, which is trivial in SQL (retriever.py:29) but would require dual-writes and external filtering otherwise. DECISIONS.md ADR-002 explicitly states a dedicated store 'is not justified' at 384 dims and these data volumes.
- *In-process FAISS / hnswlib index (no DB-backed vectors)* — Vectors are bulk-inserted per combination during the worker pipeline and queried scoped by combination_id; an in-memory index would not survive process restarts, would not be shared between the API and the arq worker (separate containers), and would lose the transactional join with metadata that the single-Postgres design provides.
- *Separate relational DB + separate vector store (two databases)* — Rejected for the same reason in ADR-002: it introduces a second deploy/backup target and a sync problem. chunklab instead splits concerns by Postgres schema (core vs results) within one instance (setup_db.py:25-26), keeping one thing to deploy/back up while still cleanly separating inputs from generated artifacts.
- *pgvector with IVFFlat index instead of HNSW* — IVFFlat requires training on existing data (a populated table) to build lists, which is awkward when chunks are inserted incrementally per combination during the run; the code chose HNSW specifically because it needs 'no training, supports inserts' (setup_db.py:29).

### Single SQLAlchemy MetaData, two Postgres schemas, cross-schema FKs  
*Data & storage*

**Chosen:** One `DeclarativeBase` with a single `MetaData()` instance backs all ORM models; `CoreBase` and `ResultsBase` are just aliases of that one `Base` (base.py:17-23). Tables are assigned to two Postgres schemas via per-table `__table_args__ = {"schema": "core"}` / `{"schema": "results"}`, and FKs cross the schema boundary freely (e.g. `results.chunks.file_id -> core.files.id`, `results.chunks.combination_id -> core.run_combinations.id`). A single `Base.metadata.create_all` builds everything in dependency order (setup_db.py:28).

**Why:**
- Cross-schema FKs require a shared MetaData: results tables (chunks, qa_pairs, retrievals, metrics, combination_stats) reference core tables (files, runs, run_combinations) by string FK target like "core.files.id"; one MetaData lets create_all resolve and topologically sort these so dependency order is correct (base.py:6-8, setup_db.py:27-28).
- The two-schema split cleanly separates configuration/inputs (core: projects, files, parsed_documents, runs, run_combinations) from generated experiment artifacts (results: chunks+vectors, stats, qa_pairs, retrievals, judge_evaluations, metrics), so results can be wiped/recomputed without touching inputs.
- Everything still lives in one Postgres instance, so vectors and their relational metadata are joined in a single transactional SQL query (chunks.embedding + chunks.file_id) with no dual-write/sync boundary.
- CoreBase/ResultsBase aliases keep the model files readable and per-schema even though there is physically one registry, so import-time table registration on the shared metadata just works (models_core/results import their alias from base).
- ondelete=CASCADE on the cross-schema FKs (e.g. chunks.combination_id, chunks.file_id) gives DB-enforced cleanup across schemas, which only works because both schemas are in the same database/metadata.

**Alternatives rejected:**
- *One MetaData per schema (separate CoreBase and ResultsBase with distinct MetaData objects)* — create_all on a results-only MetaData could not resolve FK targets in core (e.g. results.chunks.file_id -> core.files.id) or order creation correctly; base.py:6-8 explicitly states one MetaData 'is required so cross-schema foreign keys resolve during create_all'.
- *Single public schema, no namespacing (all tables in one flat schema)* — Loses the explicit inputs-vs-outputs boundary; the codebase deliberately namespaces core (config/inputs) and results (generated artifacts) so results are obviously disposable/recomputable (ADR-002, models split into two files).
- *Two separate databases (relational DB for core, vector/results DB elsewhere)* — Would forbid DB-level cross-schema FKs and CASCADE deletes, and reintroduce a second consistency boundary / dual-write sync; the design keeps one Postgres instance so vectors and metadata join transactionally (ADR-002 Context/Consequences).
- *Standalone vector store for embeddings + Postgres for metadata* — Rejected for the same reason: it splits chunk rows from their embeddings across stores, breaking single-query joins and the FK from chunks to core.files/run_combinations; pgvector(384) inline on results.chunks avoids the extra infrastructure (ADR-002).

### Idempotent init_db() create_all instead of Alembic migrations  
*Data & storage*

**Chosen:** chunklab bootstraps the schema idempotently at startup rather than with a migration tool. `init_db()` runs inside one transaction and does: `CREATE EXTENSION IF NOT EXISTS vector`, `CREATE SCHEMA IF NOT EXISTS core/results`, `Base.metadata.create_all` (checkfirst), and `CREATE INDEX IF NOT EXISTS` for the HNSW vector index (setup_db.py:22-37). It is invoked from the FastAPI lifespan (main.py:38) and from the seed script (seed.py:53). There is no Alembic config, env.py, or version files — `backend/alembic/versions/` is empty.

**Why:**
- Disposable v0.1 data with a frequently-changing schema: idempotent create_all lets models evolve (edit models_core.py/models_results.py, restart) without authoring/ordering migration files (DATA_MODEL.md:497-499, DECISIONS.md:313-314).
- Self-sufficient startup: lifespan calls init_db() before serving (main.py:37-39), so bringing up the stack needs no separate migration step in any deploy target (DECISIONS.md:333).
- Every statement is guarded (IF NOT EXISTS / create_all checkfirst), so re-running on an already-initialized DB and the Docker infra/init.sql overlap are both safe no-ops (setup_db.py:1-5,24-34; DATA_MODEL.md:519-522).
- create_all handles cross-schema FK ordering automatically because one shared MetaData holds both schemas, e.g. results.chunks.file_id -> core.files.id (base.py:1-8,17-18; setup_db.py:27).
- The HNSW index is hand-written SQL in the same bootstrap because SQLAlchemy create_all does not model pgvector HNSW indexes (setup_db.py:29-36; DATA_MODEL.md:492-493).

**Alternatives rejected:**
- *Alembic migrations (autogenerate + versioned revisions)* — The dependency is even installed (requirements.txt:33), but it is deliberately unused in v0.1: authoring/ordering revisions slows iteration while the schema is unstable, and create_all gives no migration history or in-place ALTER of existing tables — accepted because data is disposable. Docs call Alembic the expected next step once the schema stabilizes (DECISIONS.md:336-339).
- *Raw SQL DDL scripts run by an entrypoint/migration job* — Docker already ships infra/init.sql for extension+schemas (DATA_MODEL.md:519-522), but maintaining table DDL by hand would duplicate the SQLAlchemy models and lose create_all's automatic cross-schema FK ordering from the single MetaData (base.py:1-8).
- *Two separate MetaData registries (one per schema), each create_all'd in order* — Rejected explicitly: with separate registries the cross-schema FK target (results.chunks.file_id -> core.files.id) lives in a different registry and create_all cannot resolve it — base.py uses one MetaData with CoreBase/ResultsBase as aliases (base.py:6-8,17-23).
- *Drop-and-recreate / no bootstrap (manual DB provisioning)* — Not chosen because startup must be self-sufficient and safe to re-run across API and worker processes; idempotent create_all preserves existing data on restart whereas drop-recreate would wipe it (setup_db.py:22-37; DECISIONS.md:333).

### UUID primary keys (not auto-increment integers)  
*Data & storage*

**Chosen:** Every table in both schemas uses a UUID primary key, generated client-side via a shared `_pk()` helper: `mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)`. The helper is duplicated identically in `models_core.py:14-15` and `models_results.py:16-17`, and all 12 models call it for their `id` column. All foreign keys are correspondingly typed `UUID` (e.g. `File.project_id`, `Chunk.combination_id`), and even denormalized references are UUID arrays (`Retrieval.retrieved_chunk_ids: ARRAY(UUID(as_uuid=True))`, models_results.py:88-90). No table uses Integer/BigInteger/SERIAL/Identity for its PK.

**Why:**
- Client-side generation (uuid.uuid4 default) lets the worker mint IDs in Python before INSERT, so the arq pipeline can build/relate Chunk, Retrieval and JudgeEvaluation rows in memory without a DB round-trip to read back a sequence value — useful for the bulk-insert chunk path described in backend/CLAUDE.md.
- IDs are globally unique across two schemas (core and results) and across cross-schema FKs (results.chunks.file_id -> core.files.id), so there is no per-schema sequence coordination and no risk of collision when joining core and results data.
- Denormalized UUID arrays work cleanly: retrievals.retrieved_chunk_ids stores ordered top-k chunk IDs as ARRAY(UUID) (models_results.py:88-90) — UUIDs are self-describing and safe to embed in arrays/JSON without exposing a guessable sequence.
- Non-sequential, non-enumerable IDs are safer to expose in URLs/API bodies; the API and frontend pass project/run/file UUIDs directly (e.g. config.file_ids accepts a list of UUIDs per ARCHITECTURE.md), avoiding leaking row counts or enabling ID-guessing.
- Uniform PK type via one _pk() helper keeps all 12 models consistent and makes the idempotent create_all bootstrap (setup_db.init_db) trivial — no sequence/identity DDL to manage outside Alembic, which the project intentionally omits in v0.1 (ADR-009).

**Alternatives rejected:**
- *Auto-increment integer / BIGSERIAL surrogate keys* — Would require a DB round-trip (RETURNING id) to learn each key before relating dependent rows, complicating the worker's in-memory pipeline (chunks -> retrievals -> judge_evaluations); sequential IDs are also enumerable when exposed in API URLs and would need separate sequences coordinated across the core and results schemas.
- *Postgres GENERATED ALWAYS AS IDENTITY columns* — Same DB-side-generation drawback as serial (IDs known only after INSERT) and same enumerability; chunklab generates IDs in Python (default=uuid.uuid4) so the worker controls IDs before persistence.
- *Server-side UUIDs via gen_random_uuid()/uuid_generate_v4() DEFAULT in DDL* — The code chooses Python-side default=uuid.uuid4 instead, so IDs exist before the row is sent to Postgres (needed for building related objects in the pipeline); a server default would not give the app the value until after INSERT and would add pgcrypto/uuid-ossp DDL to the otherwise minimal init_db bootstrap.
- *Natural / composite keys (e.g. run_id + strategy + label, or file path)* — Run combinations are deduped by label and many entities (chunks, qa_pairs, retrievals) have no stable natural identity; status/label fields mutate, so a stable opaque surrogate UUID is simpler and avoids wide composite FKs across the many cross-schema relationships.

### Local embeddings via FastEmbed bge-small-en-v1.5 (384-dim), not an embedding API  
*ML & evaluation*

**Chosen:** Chunks and queries are embedded in-process with FastEmbed's `TextEmbedding(BAAI/bge-small-en-v1.5)` producing 384-float normalized vectors; no hosted embedding API is called. `get_embedding_model()` lazy-loads and caches the model (`embedding.py:15-21`), `embed_texts()`/`embed_query()` run the batch locally (`embedding.py:24-33`), and the model is configured via `EMBEDDING_MODEL`/`EMBEDDING_DIM` settings (`config.py:18-19`). The same model's HuggingFace AutoTokenizer (tiktoken fallback) is reused for honest token counts (`embedding.py:36-55`). The worker calls these in a thread and bulk-inserts vectors into the pgvector `vector(384)` column (`run_pipeline.py:153,216,219`; `models_results.py:35`).

**Why:**
- Cost: comment labels embeddings local and free (config.py:17); real dollar cost only comes from Groq, and embedding cost is purely notional (EMBED_COST_PER_1K, config.py:34; pricing.embedding_cost). A run embeds many chunks across many combinations (run_pipeline.py:216-219), so a per-chunk API rate would dominate cost.
- Offline/no-key: no GROQ_API_KEY or network needed to embed; only the LLM steps require the external key (config.py:14), keeping local/dev runs self-contained.
- Dimension consistency: 384-dim is hard-wired through EMBEDDING_DIM into the pgvector column `Vector(EMBEDDING_DIM)` (models_results.py:13,35) and the HNSW cosine index, so a fixed local model keeps schema/index aligned.
- Normalization: FastEmbed normalizes BGE vectors by default, so cosine distance is exact for retrieval (embedding.py:1-5) without an extra normalize step.
- Tokenizer fidelity: counting tokens with the model's own HF tokenizer (embedding.py:43,54) gives honest token volumes that make the notional embedding cost a fair cross-combination comparison.

**Alternatives rejected:**
- *Hosted embedding API (e.g. OpenAI text-embedding-3, Cohere, or Groq-side embeddings)* — Adds per-chunk cost and network latency on every chunk across every combination (run_pipeline.py:216-219) and requires another API key; the design deliberately keeps embeddings free/local so only Groq judge/chat is billed (config.py:17,34; pricing.py).
- *Larger local embedding model (e.g. bge-large or a 768/1024-dim model)* — Would not fit the fixed `vector(384)` column / HNSW index without changing EMBEDDING_DIM and recreating the index (models_results.py:13,35); for relative comparison of chunking strategies a small CPU-friendly model is sufficient, though it is config-swappable via EMBEDDING_MODEL/EMBEDDING_DIM (config.py:18-19).
- *Heuristic / tiktoken-only token counting instead of the model's own tokenizer* — Token counts feed the notional embedding cost used to compare combinations; the code prefers the model's HF AutoTokenizer for accuracy and only falls back to tiktoken cl100k_base on load failure (embedding.py:40-55).
- *Sentence-Transformers / raw PyTorch embedding runtime* — FastEmbed runs BGE on ONNX/CPU with default normalization (embedding.py:1-5,17,21), avoiding a heavier Torch/GPU dependency; the codebase only imports fastembed for embeddings, with transformers used solely for the tokenizer.

### Cost model: notional embedding rate + real Groq token cost  
*ML & evaluation*

**Chosen:** Per-combination cost = a notional embedding cost (token_volume * a configurable fake per-1k rate, since local FastEmbed embeddings are actually free) plus the real Groq judge cost computed from actual response.usage token counts. The two functions live in app/core/pricing.py (embedding_cost, groq_cost) and are summed in the worker (e_cost + j_cost) into CombinationStats.total_cost_usd.

**Why:**
- Embeddings are local/free (FastEmbed bge-small, app/core/config.py:17-19), so a real embedding bill is $0; without a notional rate every combination's embedding cost would be zero and hide that bigger/more chunks consume more embedding work (pricing.py:2-5)
- Token volume is the only thing that varies between chunking combinations on the embed side, so embedding_cost = total_tokens/1000 * EMBED_COST_PER_1K (pricing.py:13) gives a monotonic, dollar-comparable proxy that drives the cost-vs-accuracy x-axis (analytics.py:32, reporting.py:39-41)
- The judge step is a genuine Groq API spend, so it is metered for real from the model's own usage object: judge_in/judge_out accumulate jr.prompt_tokens/completion_tokens (run_pipeline.py:270-271) and feed groq_cost (pricing.py:16-22)
- All three rates are config knobs (EMBED_COST_PER_1K=0.00002, GROQ_INPUT_COST_PER_M=0.59, GROQ_OUTPUT_COST_PER_M=0.79; config.py:34-36), so the notional rate can be tuned to a hypothetical hosted embedding price and Groq rates updated without code changes
- Cost is precomputed and denormalized at aggregation time into CombinationStats (run_pipeline.py:301-310; models_results.py:51-53), so results/analytics/chat just read stored numbers instead of recomputing

**Alternatives rejected:**
- *Report embedding cost as $0 (true cost of local embeddings)* — It is honest but useless for comparison: every combination would show identical $0 embedding cost, erasing the signal that combinations producing more/larger chunks do more embedding work and making the cost-vs-accuracy tradeoff axis flat (pricing.py:2-5)
- *Meter ALL Groq calls (QA generation + judge + chat) into the cost number* — Only judge tokens are folded into a combination's cost (run_pipeline.py:270-271,300). QA generation is a single shared set per run reused across all combinations, so charging it per combination would distort per-combination comparison; the cost is deliberately scoped to the work that varies per combination (judge)
- *Estimate tokens with a heuristic (e.g. chars/4) instead of a real tokenizer* — chunklab counts tokens with the model's own HF AutoTokenizer (tiktoken fallback) per ADR-004, so total_tokens is tokenizer-accurate; pricing.py:13 multiplies that honest count, which a chars/4 heuristic would undermine
- *Pull live/official price tables from the providers at runtime* — Adds a network dependency and external coupling for what is a comparison tool; static configurable constants (config.py:34-36) keep pricing offline, deterministic, and trivially overridable per deployment

### LLM provider = Groq; model is config-driven (70b code default vs 8b-instant in .env.example)  
*ML & evaluation*

**Chosen:** chunklab uses Groq as the sole LLM provider for all three LLM roles (QA-pair generation, LLM-as-judge, and analyst chat), accessed through a single `GroqProvider` behind `get_llm()` using the async `groq.AsyncGroq` SDK with `max_retries=6` (backend/app/core/llm.py:27-92). The model is not hardcoded — it is read from `settings.GROQ_MODEL` (llm.py:35). The code default is `llama-3.3-70b-versatile` (config.py:15), but the shipped `.env.example` overrides it to the cheaper `llama-3.1-8b-instant` (.env.example:9), so a default local setup actually runs 8b-instant. The .env.example comment frames the choice explicitly: 8b-instant is friendlier on the free tier, 70b-versatile is higher quality.

**Why:**
- Single provider, single switch point: every LLM call (QA gen, judge, chat) goes through GroqProvider/get_llm() reading one GROQ_MODEL setting, so provider/model is changed in exactly one place (llm.py:35,86-92; config.py:15).
- Groq's fast inference makes the judge stage tractable: judging is one LLM call per QA pair per combination, so low latency keeps multi-combination runs feasible (DECISIONS.md:222-223).
- Model is fully config-driven, enabling the deliberate 8b-vs-70b cost/quality lever: pick 8b-instant to stay inside Groq free-tier per-minute limits, or 70b-versatile for higher-quality judging/QA, via one env var (.env.example:8-9).
- Real token usage is captured from response.usage and fed into the real Groq cost calculation, making the model choice directly visible in per-combination dollar cost (llm.py:37-45; pricing.py:16-22).
- Free/cheap open-weight models behind an OpenAI-compatible API fit a comparison tool where the LLM is plumbing, not the subject: GroqProvider is documented as free, fast inference using open-source Llama models (llm.py:28).

**Alternatives rejected:**
- *Use a separate cheaper model for the judge than for QA/chat (per-role model selection)* — GroqProvider stores exactly one self.model and uses it for chat, extract, and stream_chat alike (llm.py:35,49,59,73); run_pipeline records a single judge_model=settings.GROQ_MODEL (run_pipeline.py:279). There is no per-role override, so all three roles share one model by design — simpler config and cost accounting (DECISIONS.md:220-221).

### Dual-track evaluation: LLM-as-judge + computed IR metrics against auto-generated QA with gold passages  
*ML & evaluation*

**Chosen:** Per run, chunklab auto-generates one shared QA set by sampling evenly-spaced ~900-char passages and asking Groq to emit {question, reference_answer}, keeping each source passage as the gold span (qa_generator.py:29-74). Every combination retrieves top-k via pgvector cosine (retriever.py:20-42), then is scored two ways: (1) an LLM-as-judge (Groq, temp 0 via llm.extract) returning four 0..1 dims — relevance/faithfulness/context_precision/context_recall (judge.py:31-57); and (2) deterministic IR metrics — precision@k, recall@k, MRR, nDCG@k, F2 — where a retrieved chunk is "relevant" iff same file AND word-set overlap with the gold passage >= 0.5 (metrics.py:24-80). Both are aggregated per combination (judge means + macro-averaged IR) into results.metrics (run_pipeline.py:316-331).

**Why:**
- Fully self-contained, no human labelers: questions, answers, and ground truth are all generated from the documents themselves (qa_generator.py:47-74), so any uploaded corpus is benchmarkable with zero manual annotation.
- Fair cross-combination comparison: one shared QA set is generated once per run and reused for every combination, with question embeddings precomputed once (run_pipeline.py:127-153), so score differences reflect chunking only, not question variance.
- Two complementary signals hedge each method's weakness: the judge captures semantics the lexical overlap metric misses, while the deterministic gold-passage metrics give reproducible, cheap numbers the subjective judge cannot (metrics.py:1-9 vs judge.py:1).
- Determinism where it matters: IR metrics are pure functions of retrieved text vs gold span, and the judge runs at temperature 0 (llm.extract uses temperature=0.0, llm.py:64), maximizing reproducibility across re-runs.
- Reuses existing infra: retrieval is the same pgvector cosine KNN used by the chat RAG path, and judge token usage feeds the real Groq cost model, so accuracy and cost are computed in one pass (run_pipeline.py:254,269-281,299-309).

**Alternatives rejected:**
- *Human-annotated gold relevance labels per document/query* — Infeasible for an automated tool that ingests arbitrary user uploads; DECISIONS.md ADR-008 explicitly states 'human-labeled relevance for every document is infeasible for an automated tool,' so ground truth is generated and relevance defined by text overlap instead (metrics.py:24-32).
- *A dedicated RAG-eval framework (e.g. RAGAS) for the judged dimensions* — Not used; the judge is a single in-house Groq call with a hand-written JUDGE_PROMPT and local _clamp/JSON parsing (judge.py:31-57, prompt_texts.py:16-27). The codebase deliberately routes all LLM access through app.core.llm.get_llm() and keeps prompts in prompt_texts.py only, so an external eval lib would add a dependency and bypass those conventions.
- *Embedding/semantic-similarity relevance for the computed metrics* — Rejected in favor of cheap lexical word-set overlap (>=0.5 of gold words, metrics.py:31-32). Embeddings are already used for retrieval, but using them again for relevance scoring would make the 'deterministic, ground-truth' track depend on the same model under test; the lexical check stays model-independent and trivially explainable (DECISIONS.md ADR-008).
- *Multiple gold passages / graded relevance per question* — Each QA pair stores exactly one source passage as gold (qa_generator.py:67-69), which forces binary recall and IDCG=1 (metrics.py:58,67-70). Multi-gold would require labeling all relevant regions per question — the same annotation cost the auto-generation design avoids; DECISIONS.md ADR-008 accepts the 'binary single-gold model' as a heuristic.

### One shared QA set per run, reused across all combinations  
*ML & evaluation*

**Chosen:** The run pipeline generates a single QA evaluation set once, before the combination loop begins, and reuses it for every combination. After parsing all files, it loops over files calling generate_qa_pairs and persists QAPair rows tied to the run (not to any combination), embeds all questions once into q_vectors, then passes the same qa_records and q_vectors into each _process_combination call inside the combos loop (run_pipeline.py:127-164). QA pairs are keyed by run_id/file_id (QAPair construction at run_pipeline.py:139-149), never by combination_id, so they are not regenerated per combination.

**Why:**
- Fair comparison: every combination is scored against identical questions and identical question embeddings, so accuracy differences reflect chunking strategy, not QA randomness (run_pipeline.py:152-153, 158-159; ADR-008).
- Cost control: QA generation is Groq LLM calls and is the same regardless of combination count. Generating once amortizes that cost over the whole combinatorial matrix instead of multiplying it by the number of combos.
- Determinism of metrics: gold passages + offsets are fixed once (qa_generator stores source_chunk_text/start/end), so the ground truth used by metrics.compute_for_query is stable across all combinations (run_pipeline.py:286-291).
- Performance: question embeddings are computed exactly once (q_vectors at run_pipeline.py:153) and reused in every combination's retrieve loop, avoiding redundant embedding work per combo.
- Clean data model: QAPair belongs to the run, retrievals/judge_evaluations belong to combinations and reference the shared qa_pair, which lets results/analytics join consistently across combinations.

**Alternatives rejected:**
- *Regenerate a fresh QA set inside each combination (per-combination generation)* — Different questions per combination would make accuracy metrics incomparable across combinations, defeating the tool's core purpose of comparing chunking strategies; it would also multiply Groq QA-generation cost and latency by the number of combinations.
- *Derive QA pairs from each combination's own chunks (chunk-as-gold per combo)* — Ground truth would then depend on the strategy under test, biasing each combination toward its own chunking; the code deliberately samples fixed ~900-char passages from the parsed document independent of any strategy (qa_generator._sample_passages, run_pipeline.py:137) so the gold passage is strategy-neutral.
- *User-supplied / human-labeled QA ground truth* — ADR-008 states hand-labeling relevance for arbitrary uploaded corpora is infeasible for an automated tool; the pipeline auto-generates QA so it works on any corpus with no human annotation (DECISIONS.md:271-273, 294-295). There is no API field for uploading a QA set (RunCreate config only carries qa_per_file/max_qa, runs.py:48-49).
- *Generate QA per file but re-embed questions inside each combination loop* — Wasteful: the questions are identical across combinations, so the code precomputes q_vectors once (run_pipeline.py:153) and reuses them, avoiding repeated embedding of the same questions for every combo.

### Chunking as registry/strategy (Protocol) pattern + combinatorial expander with label dedup  
*ML & evaluation*

**Chosen:** Each chunking algorithm is a small class satisfying a `ChunkingStrategy` Protocol (`name`, `split(text, params) -> list[str]`, `label(params) -> str`) that calls `register(self)` at import time into a module-global `STRATEGY_REGISTRY` dict keyed by `name` (registry.py:5-10, base.py:15-25, sentence.py:10-27). A run request's list of `{strategy, params}` specs is turned into concrete experiment cells by `expander.expand()`: it pops an optional `sizes:[...]` list to fan out one param set per size (`{**base, "size": s}`), validates the strategy via `get_strategy`, computes a human label via `strat.label(params)`, and drops any cell whose label was already seen — global dedup keyed purely on the label string (expander.py:20-39). The worker later resolves the strategy by name and calls `split`+`assemble` per file (run_pipeline.py:195,209-210).

**Why:**
- Open/closed extensibility: adding a strategy is one self-registering class (`character`, `recursive`, `semantic`, `sentence`, `token` all follow the identical 4-line `register(...)` pattern); the single load-bearing `import app.services.chunking` in main.py picks them all up with no central edit (registry.py:8-10, __init__.py:3-9)
- Uniform interface decouples the worker from algorithm internals: the pipeline only knows `split`/`assemble`, so llama-index, langchain, pure-python, and embedding-based strategies are interchangeable behind one contract (base.py:16-25, run_pipeline.py:195,209-210)
- The whole point of the product is comparing strategy x parameter combinations, so a combinatorial fan-out is intrinsic: `sizes:[...]` expands a single spec into N cells, each becoming a `run_combination` row (expander.py:29,37)
- Label-based dedup prevents redundant (expensive) chunk+embed+judge passes when a longhand spec and a `sizes`-matrix spec resolve to the same configuration, keeping the experiment matrix clean and cost-comparable (expander.py:33-37)
- `label()` doubles as the dedup key and the human-readable display key (e.g. `sentence·512/20`), so the identity of a combination is defined in one place and is deterministic (base.py:23-24, sentence.py:21-24)

**Alternatives rejected:**
- *Hardcoded if/elif dispatch on a strategy-name string inside the worker* — Would force a central edit (and re-test) of the pipeline for every new algorithm and couple the worker to each library's API; the registry+Protocol makes strategies pluggable with zero pipeline changes (registry.py, run_pipeline.py:195)
- *Abstract base class (ABC) with inheritance instead of a structural `Protocol`* — The code deliberately uses a `@runtime_checkable Protocol`; strategies are plain classes that never import the base (e.g. sentence.py imports only `register`), so no inheritance coupling is required — duck-typed `name`/`split`/`label` is enough (base.py:15-16, sentence.py:7-10)
- *Entry-point / plugin discovery (importlib.metadata, setuptools entry_points)* — Overkill for an in-repo v0.1 with a fixed handful of strategies; simple import-time side-effect registration via the package `__init__` is lighter and needs no packaging metadata (__init__.py:3-9)
- *Pre-compute the full cartesian product of all params and run every cell unconditionally (no dedup)* — Wastes a full chunk+embed+retrieve+LLM-judge pass per duplicate combination; the expander's `seen` set collapses colliding labels so identical configs run once (expander.py:21,33-37)

### Frontend state split: TanStack Query (server) + Zustand (draft matrix only)  
*Frontend*

**Chosen:** All server-derived data flows through TanStack Query (useQuery/useMutation keyed by resource, e.g. useQuery({queryKey:["files",projectId]...}) in runs/new/page.tsx:31, QueryClientProvider in providers.tsx:8-18). The single piece of client-only state — the run-builder's in-progress combination matrix — lives in a tiny Zustand store (builder-store.ts: combos:DraftCombination[] with add/remove/clear, dedup by label). The builder page reads/writes Zustand for combos but reads files via Query and submits via a Query useMutation (createRun), calling clear() on success (runs/new/page.tsx:17,48-64). All actual API calls are centralized in api.ts.

**Why:**
- Server data and draft UI data have different lifecycles: file lists, runs, and results are cache-managed (fetch/refetch/invalidate) by TanStack Query, while the matrix is purely local scratch state that only matters until createRun succeeds — so two tools each handle what they are good at
- The draft store is genuinely tiny and ephemeral: just an array of DraftCombination plus add (dedup-by-label returning false on duplicate), remove, clear — Zustand expresses this in ~20 lines (builder-store.ts:11-20) with no provider/boilerplate
- Dedup and 'total jobs' math need to live outside React component-tree teardown so the matrix survives re-renders and is shared between the strategy picker and the sticky matrix summary on the same page (runs/new/page.tsx:200-238); a global store is cleaner than lifting state through props
- Keeping server data out of Zustand avoids cache-coherence bugs: frontend/CLAUDE.md:71 and :109 explicitly mandate 'do not duplicate server data into React state or Zustand' — Query stays the single source of truth for anything from the API
- Centralized api.ts wrappers (api.ts:36-147) feed Query/mutations uniformly, so the only thing left needing a client store is the draft matrix

**Alternatives rejected:**
- *Plain useState in the builder page for the matrix (no Zustand)* — Workable since the matrix is only used on runs/new/page.tsx, but the page already juggles many useState slices (name, topK, params, scope, selected); a dedicated store keeps the dedup/add/remove logic and DraftCombination shape reusable and testable in one place rather than inlined, and survives independently of component mount. The codebase chose to isolate it (builder-store.ts) per frontend/CLAUDE.md:73-80.
- *Put draft matrix into TanStack Query cache (e.g. setQueryData) and use one tool* — The matrix is never fetched from or written to the server until launch, so it has no query key, no staleness, and no invalidation story — modeling it as server cache misuses Query. CLAUDE.md:80 keeps Query strictly for API-derived data.
- *React Context + useReducer for global draft state* — Would require wrapping the tree in another provider (only QueryClientProvider exists, providers.tsx:18) and triggers re-renders of all consumers on every combo change; Zustand gives selector-based subscriptions with zero provider for a one-store need.
- *Redux Toolkit for all client state* — Far heavier (store config, slices, provider, actions) than warranted for a single 3-field draft list; the app has exactly one piece of non-server client state, so RTK's structure would be pure overhead vs Zustand's ~20-line store (deps in package.json show zustand ^5, no redux).

### Chat streams via fetch + ReadableStream; progress streams via native EventSource (SSE)  
*Realtime*

**Chosen:** chunklab uses two distinct server→client streaming transports. Chat is a POST: `POST /api/v1/chat/stream` returns a FastAPI `StreamingResponse(token_stream(), media_type="text/plain; charset=utf-8")` (chat.py:43) where `token_stream` async-yields Groq deltas from `stream_answer` -> `llm.stream_chat(... stream=True)` (chat_service.py:19, llm.py:69-80). The frontend calls `chatStream(payload)` with `fetch` (api.ts:141-147) and reads the raw `res.body.getReader()` + `TextDecoder`, appending each decoded chunk to the assistant message (ChatPanel.tsx:58-72). Progress, by contrast, uses native `EventSource` over true SSE: `GET /runs/{id}/progress/stream` returns `sse_starlette` `EventSourceResponse` (progress.py:66) consumed by `new EventSource(progressStreamUrl(runId))` in useRunProgress.ts:31.

**Why:**
- Chat is a POST carrying a JSON body (scope, message, history, project_id/run_id/run_ids per ChatPayload, api.ts:133-147); native EventSource is GET-only and cannot send a request body, so fetch+ReadableStream is the natural fit for a streamed response to a POST.
- The chat payload is one-shot request/response (send a question, stream one answer) rather than a long-lived subscription, so the heavier SSE replay/reconnect machinery in progress.py (snapshot replay + Redis pub/sub) buys nothing here.
- The backend already streams tokens natively: GroqProvider.stream_chat sets stream=True and yields delta.content (llm.py:69-80), so a plain text/plain StreamingResponse passes tokens straight through with no SSE framing needed.
- Frontend consumption is trivial — TextDecoder over res.body chunks with no event/data parsing (ChatPanel.tsx:60-70) — and incremental UI append is built directly on top.
- Progress genuinely needs SSE features (auto-reconnect, late-joiner state replay, many small fan-out events from the worker), which is why the two flows deliberately use different transports rather than one.

**Alternatives rejected:**
- *Use native EventSource for chat too (one streaming style everywhere)* — EventSource only issues GET requests and cannot carry a request body; chat needs to POST scope/message/history/run ids (chat.py:18-19, api.ts:141-146), so it cannot ride EventSource without smuggling state into the URL.
- *WebSockets for chat (and/or progress)* — Chat is strictly one-directional server→client token streaming with a single request; a full-duplex stateful WebSocket connection is more infrastructure (handshake, connection lifecycle) than a single POST stream needs. The code uses none — no websocket route exists.
- *sse_starlette EventSourceResponse for chat, matching progress.py* — It would add SSE event/data framing the client must parse, yet still cannot solve the GET-only POST-body problem; the chat handler instead returns a bare text/plain StreamingResponse (chat.py:43) the client reads as raw bytes.
- *Non-streaming JSON: buffer the full answer and return it once* — Loses the token-by-token UX the UI is built around (ChatPanel appends each decoded chunk live, ChatPanel.tsx:66-70) and the backend already exposes a token generator (llm.stream_chat), so buffering would discard a free incremental experience and feel slow for long Groq completions.

### One image for backend + worker, CPU-only torch, shared model-cache volume  
*Infra & ops*

**Chosen:** Both the FastAPI API and the arq worker are built from a single `Dockerfile.backend` and differentiated only by command (API runs `uvicorn`, worker runs `arq app.workers.settings.WorkerSettings`). The image installs CPU-only torch/torchvision from PyTorch's CPU wheel index (before and re-pinned after the rest of requirements, so docling can't drag in CUDA), and sets the model cache dirs (`HF_HOME`, `FASTEMBED_CACHE_PATH`) under `/root/.cache`, which both containers mount via the shared `hf_cache` volume so the embedding model downloads once and is reused.

**Why:**
- Backend and worker run the exact same async codebase (app.workers reuses app.core.embedding, app.core.llm, app.db) — a single image guarantees code/dependency parity and halves build time vs maintaining two Dockerfiles (Dockerfile.backend:1, docker-compose.yml:33-36,60-66).
- docling depends on torch, which by default pulls the multi-GB CUDA stack; the deployment is CPU-only (FastEmbed bge-small runs on ONNX/CPU), so forcing CPU wheels keeps the image small and avoids shipping an unusable GPU runtime (Dockerfile.backend:14-17).
- Both API and worker load the same HF/FastEmbed model; a shared cache volume means the ~tens-of-MB model is fetched once, not once per container, and survives restarts (Dockerfile.backend:32-34, docker-compose.yml:48,74,100).
- The worker warms the embedding model on startup (app/workers/settings.py `_startup`), so a populated shared cache lets that warm-up hit disk instead of the network — first run isn't penalized by a cold download.
- docling/torchvision can otherwise resolve a torchvision built against a different torch and break `torchvision::nms`; the explicit reinstall of the matched CPU pair after requirements keeps docling importable (Dockerfile.backend:23-26).

**Alternatives rejected:**
- *Two separate Dockerfiles/images (one for API, one for worker)* — The two services share the entire codebase and dependency set (torch, docling, FastEmbed, Groq SDK) and differ only by launch command; two images would duplicate the heavy build and risk dependency drift between API and worker. Compose already expresses the difference with `command:` on line 66.
- *Default (GPU/CUDA) torch install* — Pulls hundreds of MB of CUDA libraries that are never used — embeddings run on FastEmbed ONNX/CPU and there is no GPU in the stack — so the comment on Dockerfile.backend:14-15 explicitly installs from the CPU wheel index to avoid the CUDA build.
- *Per-container model cache (no shared volume) or baking the model into the image at build time* — Per-container caches would download the model twice (once for backend, once for worker) and lose it on rebuild; the chosen `hf_cache` volume shared on `/root/.cache` (docker-compose.yml:48,74) downloads once and persists. Baking at build time isn't done here — the model is fetched lazily and cached at runtime.
- *Run the worker as a thread/subprocess inside the backend container instead of a separate service* — Heavy parsing/embedding/judge work would compete with the API event loop and couple their lifecycles/scaling; chunklab instead runs `worker` as its own container (docker-compose.yml:60-81, `max_jobs=4`, 1h job timeout in settings.py) so the API stays responsive while sharing the same image.

### Discard raw upload after parsing; keep only extracted text  
*Data & storage*

**Chosen:** In `_ensure_parsed`, immediately after a successful parse chunklab persists the extracted text as a `ParsedDocument` (clean_text, char_count, page_count), then deletes the raw uploaded file from disk via `Path(file.storage_path).unlink(missing_ok=True)` and clears `file.storage_path = ""`, setting `file.status = "parsed"`. Only the extracted text is retained; the original bytes are not kept. This runs once per file (existing ParsedDocument short-circuits at the top of `_ensure_parsed`), so re-runs reuse the stored text and never re-touch disk.

**Why:**
- Parsing is computed once and persisted (ParsedDocument), and chunking only ever consumes clean_text (run_pipeline.py:209 strat.split(doc.clean_text,...) and qa_generator at :137 use clean_text) — so the raw bytes have no downstream consumer once parsing succeeds
- Deleting the raw file frees disk in the local STORAGE_DIR (backend/app/data/uploads, config.py:42) volume immediately rather than accumulating originals for every upload
- Aligns with the privacy posture already in .gitignore — user uploads are NEVER committed (lines 39-44); discarding them after extraction minimizes retained sensitive source material
- Idempotent and cheap: the early-return on an existing ParsedDocument (run_pipeline.py:49-50) means repeated runs reuse the extracted text with no parse and no file I/O
- Keeps the File row as durable metadata (filename, mime_type, size_bytes, parser_used, parse_options) while the heavy artifact (raw bytes) lives only transiently on disk

**Alternatives rejected:**
- *Retain the raw upload on disk indefinitely (keep storage_path populated)* — No code path re-reads the original after parsing — chunking, QA gen, retrieval and judging all run off clean_text — so keeping originals only consumes disk in the uploads volume with no functional benefit
- *Store raw bytes in Postgres (BYTEA) or object storage (S3/MinIO) for durability/re-parse* — Not implemented and over-built for v0.1: there is no object-store dependency, and ParsedDocument already makes parsing once-per-file; re-parsing isn't a supported flow, so durable raw storage adds infra cost for an unused capability
- *Keep raw bytes until run completion, then garbage-collect* — Adds lifecycle/GC bookkeeping tied to run state; the code instead deletes eagerly at parse time because the extracted text is the only artifact any later stage needs
- *Never persist the parse — re-parse the upload on each run from the retained file* — Parsing (docling, in a thread) is expensive; the design persists ParsedDocument and reuses it (_ensure_parsed early return), making the retained original redundant and re-parsing wasteful

### Rate limiting via slowapi (in-process) + multi-level request/client logging to stdout  
*Infra & ops*

**Chosen:** A single in-memory slowapi `Limiter` keyed by client IP (`get_remote_address`) with a generous global default of 600/minute, plus stricter per-route `@limiter.limit(...)` decorators on the expensive write endpoints (upload 120/min, run-create 30/min, chat 30/min). Wired in `main.py` via `app.state.limiter`, slowapi's `RateLimitExceeded` handler, and `SlowAPIMiddleware`. Logging is layered: a `configure_logging()` that adds one stdout StreamHandler at the root, named loggers (`access`, `client`, plus per-module), an HTTP middleware that logs every request as info/warning/error by status class (skipping `/health`) with millisecond timing, and a `POST /api/v1/logs` endpoint that ingests batched frontend UI events (debug/info/warn/error) into the backend `client` logger so they appear in `docker compose logs backend`.

**Why:**
- Single-process, single-instance v0.1 deployment: slowapi's default in-memory storage needs no extra infra and the global 600/min cap is a cheap abuse guard (ratelimit.py:10-12)
- The genuinely expensive work (file upload -> parse_file_task, run creation -> pipeline, LLM chat stream) is exactly what gets the tight per-route limits, protecting Groq/embedding cost and the arq queue (files.py:22, runs.py:21, chat.py:17)
- Container-native observability: everything logs to one stdout handler so `docker compose logs backend` is the single pane of glass; no log files, rotation, or external sink to manage (logging.py:11-17)
- Status-aware request logging (info 2xx/3xx, warning 4xx, error 5xx, exception->500) gives triage signal without a tracing stack, and skipping /health keeps health-probe noise out (main.py:62-83)
- Folding frontend errors/clicks into the same backend stream via the /logs batch endpoint means UI failures are debuggable next to the API call that caused them, without a separate frontend telemetry service (logs.py:1-43, logger.ts:32-37)

**Alternatives rejected:**
- *Redis-backed slowapi storage (storage_uri=redis://, coredis extra)* — Redis is already in the stack, but the code deliberately stays in-memory and notes Redis is only needed for multi-instance; v0.1 runs one backend container so a shared counter buys nothing (ratelimit.py:10-12)
- *Nginx / API-gateway rate limiting at the edge* — There is no gateway layer in front of FastAPI here; limits live in-app so they can be per-route and aware of the actual handler cost (per-route decorators in files.py/runs.py/chat.py), which an edge layer treating all paths uniformly could not express as cleanly
- *Structured JSON logging (structlog / python-json-logger) shipped to an aggregator (ELK/Loki/Datadog)* — logging.py uses a plain human-readable text Formatter to stdout with no JSON or external shipper; for a v0.1 single-node tool, `docker compose logs` is sufficient and avoids an aggregation stack (logging.py:13)
- *A dedicated frontend telemetry/error service (e.g. Sentry) instead of a homegrown /logs ingest* — The project intentionally routes UI events into the existing backend log stream via a tiny batching endpoint so there's one place to read logs and no third-party dependency or key to manage (logs.py:1-2, logger.ts)

---
*Source of truth: the code under `backend/app/` and `frontend/src/`; the chunking and evaluation appendices are real output from the running stack.*