# chunklab — Architecture

chunklab is an experimentation platform for evaluating document **chunking
strategies** for retrieval-augmented generation. You upload documents, define a
matrix of chunking combinations (strategy × parameters), and chunklab runs each
combination end-to-end — chunk, embed, store vectors, generate a shared QA set,
retrieve, judge, and score — then surfaces cost-vs-accuracy analytics and a
context-aware chat over the results.

This document describes the system topology, the full request/job lifecycle, the
boundary between the synchronous API and the asynchronous worker, and how live
progress flows from the worker to the browser via Redis pub/sub and Server-Sent
Events (SSE).

---

## 1. System overview

The platform is a monorepo (`backend/`, `frontend/`, `infra/`, `docs/`) deployed
as five cooperating services:

| Service | Role | Tech |
|---|---|---|
| **frontend** | UI: project/file management, run configuration, live progress, analytics dashboards, chat | Next.js 15 (App Router), TypeScript, Tailwind v3, TanStack Query, Recharts, Zustand |
| **backend** | Synchronous REST API; enqueues jobs; reads results; streams progress + chat | FastAPI, SQLAlchemy 2 (async), asyncpg |
| **worker** | Asynchronous job execution: parsing and the full experiment pipeline | arq (Redis queue), FastEmbed, HF tokenizer, docling, Groq SDK |
| **postgres** | Durable state + vector store | PostgreSQL 16 + pgvector (HNSW index) |
| **redis** | Job queue **and** progress pub/sub + snapshot store | Redis 7 |

The backend and worker run the **same Docker image** (`Dockerfile.backend`) with
different entrypoints — the backend runs `uvicorn`, the worker runs
`arq app.workers.settings.WorkerSettings`. They share the codebase, the upload
volume, and a Hugging Face model cache (`hf_cache`) so the embedding model is
downloaded once and reused.

### Key design choices

- **Sync/async split.** The API never performs heavy work inline. Anything
  involving parsing, embedding, or LLM calls is enqueued to arq and executed by
  the worker. The API stays fast and responsive.
- **Local, free embeddings.** Embeddings are computed locally with FastEmbed
  (`BAAI/bge-small-en-v1.5`, 384-dim). Embedding cost is *notional* (a fixed
  `EMBED_COST_PER_1K`) purely so combinations remain dollar-comparable; only
  Groq judge calls incur real cost.
- **Two schemas.** Operational data lives in the `core` schema
  (`projects`, `files`, `parsed_documents`, `runs`, `run_combinations`); derived
  experiment output lives in the `results` schema (`chunks` with the
  `vector(384)` embedding, `combination_stats`, `qa_pairs`, `retrievals`,
  `judge_evaluations`, `metrics`).
- **Idempotent startup bootstrap (no Alembic in v0.1).**
  `app/db/setup_db.py:init_db()` runs at backend startup and is safe to re-run:
  `CREATE EXTENSION vector`, `CREATE SCHEMA core/results`, `create_all` for both
  metadatas, and the HNSW index on `chunks.embedding`
  (`vector_cosine_ops`, `m=16`, `ef_construction=64`).

---

## 2. Service topology (ASCII)

```
                                  Browser (Next.js 15, :3000)
                                  ───────────────────────────
                                  • TanStack Query  → REST polling
                                  • EventSource     → SSE progress stream
                                  • fetch+ReadableStream → chat token stream
                                            │
                            HTTP / SSE / streamed text/plain
                                            │
                                            ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  backend  (FastAPI + uvicorn, :8000)         Dockerfile.backend │
        │  ───────────────────────────────────────────────────────────── │
        │  /api/v1  routers: projects, files, runs, progress,             │
        │           results, analytics, chat        /health               │
        │  lifespan: configure_logging → init_db → app.state.arq pool     │
        │  • Reads/writes core+results via async SQLAlchemy               │
        │  • ENQUEUES jobs onto arq (Redis)                               │
        │  • SUBSCRIBES to Redis pub/sub to relay SSE                     │
        └───────┬───────────────────────────┬───────────────────┬────────┘
                │ SQL (asyncpg)              │ enqueue / pub-sub  │ Groq API
                │                            │                    │ (chat only)
                ▼                            ▼                    ▼
   ┌────────────────────────┐   ┌────────────────────────┐   (api.groq.com)
   │ postgres :5432         │   │ redis :6379            │
   │ pgvector/pgvector:pg16 │   │ redis:7-alpine         │
   │ ──────────────────────  │   │ ─────────────────────── │
   │ schema core            │   │ • arq job queue        │
   │ schema results         │   │ • pub/sub channel      │
   │ chunks.embedding       │   │   run:{id}:progress    │
   │   vector(384) + HNSW   │   │ • snapshot hash        │
   └──────────▲─────────────┘   │   run:{id}:state (24h) │
              │                  └───────────▲────────────┘
              │ SQL (asyncpg)                │ dequeue / publish
              │                              │
        ┌─────┴──────────────────────────────┴───────────────────────────┐
        │  worker  (arq, SAME image as backend)        Dockerfile.backend  │
        │  ──────────────────────────────────────────────────────────────  │
        │  functions: run_pipeline, parse_file_task   max_jobs=4           │
        │  on_startup: warm embedding model                                │
        │  • docling/pypdf parsing  • FastEmbed (BAAI/bge-small-en-v1.5)   │
        │  • HF tokenizer counts    • Groq judge + QA generation           │
        │  • PUBLISHES progress to Redis (pub/sub + state hash)            │
        └─────────────────────────────────────────────────────────────────┘

   Shared Docker volumes:  uploads (file bytes, backend+worker)
                           hf_cache (model cache, backend+worker)
                           pgdata, redisdata (persistence)
```

The worker never talks to the browser directly. It talks only to Postgres (state
and vectors) and Redis (progress). The browser observes progress exclusively
through the backend, which relays Redis events over SSE.

---

## 3. The sync API vs. async worker boundary

This boundary is the central architectural seam.

### Synchronous (backend, FastAPI)

The API does only fast, transactional work and returns immediately:

- **Validates** the request and **persists** the intent to Postgres
  (e.g. create a `Run` row plus its expanded `RunCombination` rows).
- **Enqueues** a job onto arq via the shared pool
  (`app.state.arq`, created in the FastAPI lifespan).
- **Reads** durable state and derived results for the UI.
- **Relays** progress and chat token streams.

Crucially, the API performs **no parsing, no embedding, and no judge LLM calls**
inline — those are deferred. (The one place the backend calls Groq directly is
`/chat/stream`, which streams tokens for the assistant; that is a foreground
streaming response, not a background job.)

### Asynchronous (worker, arq)

The worker owns all heavy, long-running work. Two job functions are registered in
`app/workers/settings.py` (`WorkerSettings`):

- **`parse_file_task(ctx, file_id)`** — enqueued on upload. Parses one file and
  writes a `ParsedDocument`.
- **`run_pipeline(ctx, run_id)`** — the full experiment for one run. Job timeout
  is 1 hour; up to `max_jobs=4` run concurrently. On worker startup the embedding
  model is warmed so the first chunking job is not penalized by a cold load.

Communication across the boundary is **entirely indirect**: the backend writes
rows + enqueues a job; the worker reads those rows, does the work, writes results
back, and publishes progress. They never call each other over HTTP.

---

## 4. Request / job lifecycle

### 4.1 Upload → parse (interactive)

```
POST /api/v1/projects/{id}/files   (multipart, field "upload")
  backend: save bytes to uploads volume → INSERT File (status="pending")
           → enqueue parse_file_task(file_id) → 200 with File
  worker : File.status="parsing" → parse_file(storage_path) in a thread
           (docling primary; pypdf/text fallback) → INSERT ParsedDocument
           (clean_text, char_count, page_count) → File.status="parsed",
           parser_used set. On error: File.status="failed", File.error.
```

Parsing happens once per file. The run pipeline reuses an existing
`ParsedDocument` if present (`_ensure_parsed`), so uploading early lets parsing
finish before a run is launched.

### 4.2 Run launch → pipeline (the experiment)

```
POST /api/v1/projects/{id}/runs
  body: { name, top_k?, combinations:[{strategy, params}], file_ids:"all"|[uuid] }
  backend:
    • expander.expand(combinations): each spec is fanned out (params may carry
      sizes:[...]) into labeled, de-duplicated ExpandedCombination cells
    • INSERT Run (status="pending", config) + one RunCombination per cell
    • enqueue run_pipeline(run_id) → 200 with RunDetail
```

`run_pipeline` (`app/workers/run_pipeline.py`) then executes, publishing progress
at every step:

1. **Start.** `Run.status="running"`, `progress=0`, emit `run` event.
2. **Load.** Read `RunCombination`s and the target `File`s
   (`config.file_ids`: `"all"` → all project files, else the listed UUIDs).
   No files → run fails fast.
3. **Parse all files** (`_ensure_parsed` per file, reusing prior parses;
   parsing runs in a thread to avoid blocking the event loop).
4. **Generate the shared QA set once per run.** For each file,
   `generate_qa_pairs(clean_text, QA_PAIRS_PER_FILE)` samples evenly-spaced
   ~900-char gold passages and calls Groq with `QA_GENERATOR_PROMPT` to produce
   `{question, reference_answer}`, storing the gold passage and its char offsets
   as `QAPair` rows. **Question embeddings are precomputed once** and reused
   across every combination — the QA set is identical for all cells, which is
   what makes them comparable.
5. **For each combination** (`_process_combination`):
   - **Chunk → embed → store**, per file. `RunCombination.status="chunking"`.
     `strategy.split(clean_text, params)` produces raw pieces; `assemble()`
     wraps them into `Chunk(index, content, start, end)` with best-effort char
     offsets; `count_tokens()` (HF tokenizer, tiktoken fallback) counts tokens;
     `embed_texts()` (in a thread) produces 384-dim vectors; rows are bulk-
     inserted into `results.chunks` with their embedding. Chunk and embed
     latencies are accumulated.
   - **Retrieve → judge → score**, per QA pair. `status="evaluating"`. For each
     question vector, `retrieve(session, combination_id, qvec, k)` runs a
     pgvector cosine-distance KNN scoped to this combination
     (`ORDER BY distance LIMIT k`, `relevance = 1 - distance`); the result is
     saved as a `Retrieval`. `judge(question, reference_answer, contexts)` calls
     Groq (`JUDGE_PROMPT`, temp 0) for `relevance`, `faithfulness`,
     `context_precision`, `context_recall` (+ feedback), saved as a
     `JudgeEvaluation` with token usage. Computed retrieval metrics
     (`precision@k`, `recall@k`, `MRR`, `nDCG@k`, `F2`) are derived per query in
     `metrics.py` — a retrieved chunk counts as relevant if it is from the same
     file **and** word-set overlap with the gold passage ≥ 0.5.
   - **Aggregate.** Write `CombinationStats` (chunk_count, total_tokens, avg
     tokens/chunk, embedding/judge/total cost, chunk/embed/eval latencies) and
     `Metrics` (means of the judged scores + macro-averaged computed metrics +
     avg retrieval latency). `status="completed"`, emit `combo` event.
6. **Finish.** After all combinations, `Run.status="completed"`, `progress=1.0`,
   emit terminal `run` event. Any uncaught exception sets `Run.status="failed"`
   with the error and emits a failed `run` event plus an error `log`.

### 4.3 Cost model (`app/core/pricing.py`)

- `embedding_cost = total_tokens / 1000 * EMBED_COST_PER_1K` — notional, since
  local embeddings are free; included only to keep combinations comparable.
- `groq_cost = prompt_tokens/1e6 * GROQ_INPUT_COST_PER_M +
  completion_tokens/1e6 * GROQ_OUTPUT_COST_PER_M` — real, from Groq's
  `response.usage`.
- `total_cost = embedding_cost + judge_cost`.

### 4.4 Results, analytics, chat (read path)

Once a run completes, the UI reads derived data — all synchronous:

- **Results.** `GET /runs/{id}/results` returns the per-combination report;
  `GET /combinations/{id}/chunks` paginates chunk text (vectors excluded);
  `GET /runs/{id}/qa-pairs` returns the shared QA set.
  `reporting.build_run_report()` joins `run_combinations + metrics +
  combination_stats` into per-combination row dicts — the single source of truth
  reused by results, analytics, and chat.
- **Analytics.** `GET /runs/{id}/analytics/compare`,
  `GET /runs/{id}/analytics/tradeoff` (cost-vs-accuracy points), and
  `GET /projects/{id}/analytics/runs` (cross-run summary).
- **Chat.** `POST /chat/stream` (scope `project | run | compare`) builds context
  from the run report (`CHAT_SYSTEM_PROMPT`), calls Groq, and streams tokens back
  as `text/plain`; the frontend consumes them with `fetch` + `ReadableStream`.

---

## 5. Progress flow: Redis pub/sub + SSE

Progress is **dual-written** for robustness, because SSE clients can connect late
or reconnect:

- **PUBLISH** on channel `run:{run_id}:progress` → drives live SSE push.
- **HSET** on hash `run:{run_id}:state` (per-field, keyed by a stable event
  `key`, with a 24h TTL) → a current-state snapshot for late joiners.
- The aggregate progress is also **denormalized onto `Run`/`RunCombination`
  rows** so plain REST polling (`GET /runs/{id}/progress`) and post-hoc reads
  stay correct without Redis.

### Event types (`app/workers/progress.py`)

| Type | Payload |
|---|---|
| `run` | `{ status, pct }` |
| `combo` | `{ comboId, label, status, pct }` |
| `file` | `{ comboId, fileId, stage, status, pct }` |
| `log` | `{ level, message }` |

### Streaming endpoint (`app/api/routers/progress.py`)

`GET /runs/{id}/progress/stream` returns an `EventSourceResponse` that:

1. **Replays** the current snapshot — `HGETALL run:{id}:state` — so a late joiner
   immediately sees full current state.
2. **Subscribes** to `run:{id}:progress` and forwards each message as an SSE
   `data:` frame; idle ticks emit a `ping` event so the connection stays alive.
3. **Closes** when the client disconnects, or when a terminal `run` event
   (`completed | failed | canceled`) arrives.

A snapshot-only `GET /runs/{id}/progress` is also available for clients that
prefer polling over SSE.

### Sequence diagram (ASCII) — launching and observing a run

```
Browser            backend (FastAPI)        Redis                 worker (arq)            Postgres
  │                       │                    │                        │                     │
  │ POST /runs           │                    │                        │                     │
  ├──────────────────────►│ expand combos      │                        │                     │
  │                       ├──── INSERT Run + RunCombinations ───────────────────────────────►│
  │                       ├── enqueue run_pipeline(run_id) ──►│                        │     │
  │◄── 200 RunDetail ─────┤                    │                        │                     │
  │                       │                    │── dequeue ────────────►│                     │
  │ GET /progress/stream  │                    │                        │                     │
  ├──────────────────────►│                    │                        │                     │
  │                       │── HGETALL state ──►│                        │                     │
  │◄═ replay snapshot ════╡                    │                        │                     │
  │                       │── SUBSCRIBE run:{id}:progress ─►│           │                     │
  │                       │                    │                        │ Run.status=running  │
  │                       │                    │◄── PUBLISH run(running) + HSET state ────────┤
  │◄═ SSE run(running) ═══╡◄═══════════════════╡                        │                     │
  │                       │                    │       parse files (thread)                   │
  │                       │                    │◄── PUBLISH log ────────┤                     │
  │◄═ SSE log ════════════╡◄═══════════════════╡                        │                     │
  │                       │                    │       generate shared QA set (Groq)          │
  │                       │                    │       precompute question embeddings         │
  │                       │                    │                        │                     │
  │                       │            ┌── for each combination ───────────────────────────┐ │
  │                       │            │       │  combo.status=chunking │                   │ │
  │                       │            │◄── PUBLISH combo(chunking) ────┤                   │ │
  │◄═ SSE combo ══════════╡◄═══════════╡       │  split → assemble → count → embed (thread)│ │
  │                       │            │◄── PUBLISH file(chunk/embed) ──┤                   │ │
  │◄═ SSE file ═══════════╡◄═══════════╡       │  bulk INSERT chunks (vector 384) ─────────►│ │
  │                       │            │       │  combo.status=evaluating                  │ │
  │                       │            │       │  for each QA: pgvector KNN retrieve ──────►│ │
  │                       │            │       │               judge (Groq) → save eval    │ │
  │                       │            │       │               compute query metrics       │ │
  │                       │            │       │  aggregate CombinationStats + Metrics ────►│ │
  │                       │            │◄── PUBLISH combo(completed) ────┤                   │ │
  │◄═ SSE combo ══════════╡◄═══════════╡       │                        │                   │ │
  │                       │            └──────────────────────────────────────────────────┘ │
  │                       │                    │  Run.status=completed, progress=1.0 ────────►│
  │                       │                    │◄── PUBLISH run(completed) ──────────────────┤
  │◄═ SSE run(completed) ═╡◄═══════════════════╡   (terminal → stream closes)                │
  │                       │                    │                        │                     │
  │ GET /runs/{id}/results, /analytics/*, POST /chat/stream            │                     │
  ├──────────────────────►│── build_run_report (join metrics+stats) ──────────────────────►│
  │◄── reports / streamed chat tokens ────────┤                        │                     │
```

---

## 6. Deployment & runtime notes

- **Compose topology.** `postgres` and `redis` carry healthchecks; `backend`
  depends on both being healthy; `worker` depends on both plus `backend` started;
  `frontend` depends on `backend` healthy. Postgres mounts
  `infra/postgres/init.sql` (`CREATE EXTENSION vector` + schemas) at first init,
  complementing the app-side idempotent bootstrap.
- **Shared image, shared cache.** `backend` and `worker` build from
  `Dockerfile.backend`. The image installs **CPU-only torch first** so docling
  does not pull CUDA, then the rest of requirements; `libgl1`/`libglib2.0-0` are
  present for docling. `PYTHONPATH=/app/backend`. Both mount the `hf_cache`
  volume so the embedding model downloads once.
- **Ports.** 3000 frontend · 8000 backend · 5432 postgres · 6379 redis.
- **Configuration.** All settings come from `app.core.config.Settings`
  (`get_settings()`), populated from `.env`: `GROQ_API_KEY`,
  `GROQ_MODEL=llama-3.3-70b-versatile`,
  `EMBEDDING_MODEL=BAAI/bge-small-en-v1.5`, `EMBEDDING_DIM=384`, `DATABASE_URL`,
  `REDIS_URL`, `TOP_K=5`, `QA_PAIRS_PER_FILE=8`, the cost knobs
  (`EMBED_COST_PER_1K`, `GROQ_INPUT_COST_PER_M`, `GROQ_OUTPUT_COST_PER_M`),
  `CORS_ORIGINS`, and `STORAGE_DIR`. The real `.env` is gitignored; only
  `.env.example` (placeholders) is committed.
- **Common commands.**
  `docker compose up --build` ·
  `docker compose exec backend python -m app.scripts.seed` ·
  `python -m pytest backend/tests -v` ·
  `cd frontend && npm run build`.

---

## 7. Conventions

- Settings via `app.core.config.get_settings()`.
- LLM access via `app.core.llm.get_llm()`; prompts only in
  `app/prompts/prompt_texts.py` (`QA_GENERATOR_PROMPT`, `JUDGE_PROMPT`,
  `CHAT_SYSTEM_PROMPT`).
- Embeddings via `app.core.embedding`; pgvector dimension is fixed at **384**.
- All DB and LLM access is **async**.
- Chunking strategies follow a **registry pattern**: each implements
  `split(text, params) -> list[str]` and `label(params) -> str`; new strategies
  are registered by import (`import app.services.chunking` in `main.py`
  registers them all).
- All HTTP endpoints live under `/api/v1`.
