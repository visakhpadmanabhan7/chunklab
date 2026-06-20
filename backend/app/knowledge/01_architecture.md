# Architecture

chunklab is a tool for evaluating and comparing text-chunking strategies for
RAG. This document describes the runtime topology: the cooperating services, the
boundary between the synchronous API and the asynchronous worker, the end-to-end
lifecycle of a run, and how live progress reaches the browser. For what the
product does and why, see `00_what_is_chunklab.md`; for the database tables, see
`02_data_model.md`; for setup and ports detail, see `09_setup_and_stack.md`.

## Services and how they connect

chunklab is a monorepo (`backend/`, `frontend/`, `infra/`, `docs/`) that runs as
five cooperating services, wired together by `docker-compose.yml`:

- **frontend** — Next.js 15 (App Router) + TypeScript + Tailwind + TanStack
  Query + Recharts. Project/file management, run configuration, live progress,
  analytics dashboards, and chat. Talks only to the backend over HTTP/SSE.
- **backend** — FastAPI (async, SQLAlchemy 2 + asyncpg). Synchronous REST API
  under `/api/v1` plus `GET /health`. Validates and persists intent, enqueues
  jobs, reads results, and relays progress and chat streams to the browser.
- **worker** — arq (asyncio Redis queue). Runs all heavy work: file parsing and
  the full experiment pipeline. Same Docker image as the backend, different
  entrypoint (`arq app.workers.settings.WorkerSettings`).
- **postgres** — PostgreSQL 16 + pgvector. Durable relational state **and** the
  vector store (a `vector(384)` column with an HNSW index).
- **redis** — Redis 7. Serves double duty: the arq job queue **and** the
  progress pub/sub channel plus a snapshot hash.

The backend and worker build from the same `Dockerfile.backend` and share the
`uploads` volume (file bytes) and the `hf_cache` volume (embedding model cache,
downloaded once and reused). The worker never talks to the browser; the browser
only ever talks to the backend.

### Service flow

```
        Browser (Next.js 15)
   TanStack Query · EventSource · fetch+ReadableStream
                    │  HTTP / SSE / streamed text/plain
                    ▼
        backend (FastAPI + uvicorn)
        /api/v1 routers · /health
        • reads/writes Postgres (async)
        • ENQUEUES arq jobs onto Redis
        • SUBSCRIBES Redis pub/sub → relays SSE
        • calls Groq directly ONLY for /chat/stream
          │                 │                  │
   SQL (asyncpg)     enqueue / pub-sub     Groq API (chat)
          │                 │
          ▼                 ▼
   ┌────────────┐    ┌──────────────────────┐
   │ postgres   │    │ redis                │
   │ pgvector   │    │ • arq job queue      │
   │ core +     │    │ • run:{id}:progress  │
   │ results    │    │ • run:{id}:state     │
   └─────▲──────┘    └──────────▲───────────┘
         │ SQL (asyncpg)        │ dequeue / publish
         │                      │
   ┌─────┴──────────────────────┴───────────────┐
   │ worker (arq, same image as backend)        │
   │ run_pipeline · parse_file_task             │
   │ parse · chunk · embed · retrieve · judge   │
   │ Groq (QA gen + judge) · FastEmbed          │
   │ PUBLISHES progress to Redis                │
   └────────────────────────────────────────────┘
```

## Ports

Host-to-container port mappings from `docker-compose.yml` (host port first):

| Service  | Host port | Container port |
|----------|-----------|----------------|
| frontend | 3000      | 3000           |
| backend  | 8001      | 8000           |
| postgres | 5433      | 5432           |
| redis    | 6380      | 6379           |

Inside the Docker network, services reach each other by container port: the
backend and worker connect to `postgres:5432` and `redis:6379`. The frontend is
built with `NEXT_PUBLIC_API_BASE_URL=http://localhost:8001`, so the browser
reaches the backend on the host-exposed `8001`. The backend itself listens on
`8000` inside its container.

## Sync API vs. async worker boundary

This boundary is the central architectural seam. The reason heavy work is kept
off the request path: a run is a long, multi-stage pipeline (parse, generate a
QA set, chunk and embed across many combinations, retrieve, judge with an LLM,
aggregate metrics). Running any of that inline would block the HTTP request for
minutes, so the API stays thin and fast while the worker does the work.

**Synchronous (backend, FastAPI)** — fast, transactional work that returns
immediately:

- Validate the request and persist intent to Postgres (e.g. a `Run` row plus its
  expanded `RunCombination` rows).
- Enqueue an arq job through the shared pool at `app.state.arq` (created in the
  FastAPI lifespan).
- Read durable state and derived results for the UI.
- Relay progress (SSE) and chat token streams.

The API performs **no parsing, no embedding, and no judge LLM calls** inline.
The one place the backend calls Groq directly is `POST /chat/stream`, which
streams assistant tokens as a foreground response — not a background job.

**Asynchronous (worker, arq)** — all heavy, long-running work. Two job functions
are registered in `app/workers/settings.py` (`WorkerSettings`):

- `parse_file_task(ctx, file_id)` — enqueued on upload; parses one file and
  writes a `ParsedDocument`.
- `run_pipeline(ctx, run_id)` — the full experiment for one run. Job timeout is
  1 hour; up to `max_jobs=4` run concurrently. On worker startup the embedding
  model is warmed so the first chunking job is not penalized by a cold load.

Communication across the boundary is **entirely indirect**: the backend writes
rows and enqueues a job; the worker reads those rows, does the work, writes
results back, and publishes progress. The two never call each other over HTTP.

## Run lifecycle, end to end

When a run is launched, `POST /api/v1/projects/{id}/runs` (body: `name`,
`top_k?`, `combinations:[{strategy, params}]`, `file_ids:"all"|[uuid]`) does the
synchronous part: `expander.expand()` fans each combination spec out (params may
carry `sizes:[...]`) into labeled, de-duplicated cells; the backend inserts a
`Run` (status `pending`) plus one `RunCombination` per cell, enqueues
`run_pipeline(run_id)`, and returns `RunDetail`.

`run_pipeline` (`app/workers/run_pipeline.py`) then executes, publishing
progress at every step. **The pipeline is heavily parallelised** — within a
single run, files parse concurrently, the QA set is generated concurrently, and
several combinations are processed at once, each in its own DB session:

1. **Start.** `Run.status="running"`, `progress=0`, emit a `run` event.
2. **Load.** Read the `RunCombination`s and target `File`s (`config.file_ids`:
   `"all"` → all project files, else the listed UUIDs). No files → fail fast.
3. **Parse all files — concurrently.** `_ensure_parsed` runs per file in its own
   session, `asyncio.gather`-ed (bounded by `MAX_CONCURRENT_EMBED`), reusing any
   prior `ParsedDocument`; the CPU-bound parse runs in a thread.
4. **Generate the shared QA set once per run — concurrently.** Each file's
   `generate_qa_pairs(clean_text, …)` Groq call fans out together (bounded by the
   shared LLM semaphore `MAX_CONCURRENT_LLM`), then the `QAPair` rows are
   persisted in one session. **Question embeddings are precomputed once** and
   reused across every combination — the identical QA set is what makes
   combinations comparable.
5. **Process combinations concurrently** (`MAX_CONCURRENT_COMBINATIONS` at a
   time; each `_process_combination` owns a session):
   - **Chunk → embed → store**, streamed per file. `status="chunking"`.
     `strategy.split()` + `assemble()` produce `Chunk`s; `count_tokens()` counts
     tokens; `embed_texts()` (in a thread) produces 384-dim vectors; rows are
     inserted into `results.chunks`. Embedding/tokenizing run under a **shared
     lock** (the FastEmbed/ONNX session is a single shared instance, unsafe to
     call from multiple threads), and one file at a time keeps memory bounded.
   - **Retrieve → judge → score**, per QA pair. `status="evaluating"`. Retrieval
     (pgvector cosine KNN scoped to the combination) runs serially on the
     session; then the slow **`judge(...)` Groq calls fan out together**, bounded
     by the shared LLM semaphore; results and computed IR metrics
     (`metrics.py`) are persisted.
   - **Aggregate.** Write `CombinationStats` and `Metrics`; `status="completed"`,
     emit a `combo` event.
6. **Finish.** `Run.status="completed"`, `progress=1.0`, terminal `run` event.
   Any uncaught exception sets `Run.status="failed"` with the error and emits a
   failed `run` event plus an error `log`. The live `run` percentage is the mean
   of the per-combination progress, so the UI shows combinations advancing
   side-by-side.

**Why this shape.** Embedding is CPU-bound and uses one shared model, so it is
serialised — concurrency there buys nothing and risks OOM, so embeds stream one
file at a time. The real wins are the network-bound Groq calls (QA generation and
the LLM judge), which overlap freely, and the overlap of one combination's
judging with another's embedding. Concurrency limits live in `Settings`
(`MAX_CONCURRENT_COMBINATIONS`, `MAX_CONCURRENT_LLM`, `MAX_CONCURRENT_EMBED`);
the LLM cap is kept modest so free Groq tiers don't 429.

See `03_chunking_strategies.md`, `04_qa_generation_and_evaluation.md`, and
`05_retrieval_and_vector_search.md` for the details of each stage.

## Live progress transport

Progress is **dual-written** to Redis for robustness, because SSE clients can
connect late or reconnect:

- **PUBLISH** on channel `run:{run_id}:progress` — drives the live SSE push.
- **HSET** on hash `run:{run_id}:state` (per-field, keyed by a stable event
  `key`, 24h TTL) — a current-state snapshot for late joiners.
- Aggregate progress is also **denormalized onto `Run`/`RunCombination` rows**,
  so plain REST polling (`GET /runs/{id}/progress`) stays correct without Redis.

Event types (`app/workers/progress.py`): `run` (`{status, pct}`), `combo`
(`{comboId, label, status, pct}`), `file` (`{comboId, fileId, stage, status,
pct}`), and `log` (`{level, message}`).

The streaming endpoint `GET /runs/{id}/progress/stream`
(`app/api/routers/progress.py`) returns an `EventSourceResponse` that:

1. **Replays** the snapshot (`HGETALL run:{id}:state`) so a late joiner
   immediately sees full current state.
2. **Subscribes** to `run:{id}:progress` and forwards each message as an SSE
   `data:` frame; idle ticks emit a `ping` to keep the connection alive.
3. **Closes** when the client disconnects or a terminal `run` event
   (`completed | failed | canceled`) arrives.

The browser consumes this with the native `EventSource` API, which handles
reconnection automatically.

### Chat is not SSE

Chat uses a different transport. `POST /chat/stream` (scope
`project | run | compare`) builds context from the run report, calls Groq, and
streams tokens back as `text/plain`. The frontend consumes the response body
with `fetch` + `ReadableStream`, **not** `EventSource`. The reason: chat is a
POST carrying a request body (message, history, scope), which the GET-only
`EventSource` cannot send. See `06_chat_and_product_assistant.md`.

## Key architecture decisions

These are summarized from `docs/DECISIONS.md` (ADR records, project state v0.1):

- **Monorepo (ADR-001).** Backend, frontend, infra, and docs live in one
  repository so a single `docker compose up --build` brings up the whole system
  and API + UI changes ship together. The trade-off is a larger repo with no
  per-component release cadence — acceptable for a single-author v0.1.
- **Single Postgres + pgvector, two schemas (ADR-002).** One database is both
  the relational store and the vector store; embeddings live in a `vector(384)`
  column on `chunks` and similarity search is plain SQL. The `core` schema holds
  inputs/config (`projects`, `files`, `parsed_documents`, `runs`,
  `run_combinations`); the `results` schema holds outputs (`chunks`,
  `combination_stats`, `qa_pairs`, `retrievals`, `judge_evaluations`,
  `metrics`). One store means no dual-write/sync problem.
- **arq for background jobs (ADR-003).** An asyncio-native Redis queue, so the
  worker runs the same `async def` code as the API with no sync/async bridging.
  Redis is already in the stack for progress, so the queue adds no new
  infrastructure.
- **Idempotent startup bootstrap, no Alembic (ADR-009).**
  `app/db/setup_db.py:init_db()` runs in the FastAPI lifespan and is safe to
  re-run: `CREATE EXTENSION vector`, `CREATE SCHEMA core/results`, `create_all`
  on both metadatas, and the HNSW index on `chunks.embedding`
  (`vector_cosine_ops`, `m=16`, `ef_construction=64`). Fast schema iteration at
  the cost of no migration history; Alembic is the expected next step.
- **Local, free embeddings (ADR-004).** FastEmbed with
  `BAAI/bge-small-en-v1.5` (384-dim, ONNX, CPU-only) produces embeddings
  locally — no API key, no per-chunk billing. Token counts use the matching
  HuggingFace tokenizer (tiktoken fallback). The 384-dim choice is fixed across
  the schema, the column, and the index.
- **Groq for LLM work (ADR-006).** The Groq SDK with `llama-3.3-70b-versatile`
  serves all three LLM roles: QA generation, LLM-as-judge (temperature 0 for
  reproducible scores), and chat. A single provider/model keeps configuration
  and cost accounting simple; all access goes through `app.core.llm.get_llm()`.

See `08_cost_and_pricing.md` for the notional-embedding + real-Groq cost model
(ADR-007) and `09_setup_and_stack.md` for the full stack and configuration.
