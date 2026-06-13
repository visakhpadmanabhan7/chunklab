# Architecture Decision Records

This document records the significant design decisions made while building **chunklab**,
a tool for evaluating text-chunking strategies for retrieval-augmented generation (RAG).

Each entry follows an ADR-style format: **Context** (the forces at play), **Decision**
(what we chose), and **Consequences** (the trade-offs we accepted).

The decisions describe the state of the project at v0.1.

---

## ADR-001: Monorepo (backend + frontend + infra + docs)

**Context**

chunklab is made of several moving parts that evolve together: a FastAPI backend, a
Next.js frontend, infrastructure definitions (Docker Compose, init SQL), and
documentation. The API contract between backend and frontend changes frequently during
early development, and the Docker setup wires all services together. Splitting these into
separate repositories would mean coordinating cross-repo pull requests for every contract
change and maintaining version pins between them.

**Decision**

Keep everything in a single repository at `/Users/visakh/GitHub/chunking_exp` with
top-level directories:

- `backend/` — FastAPI application
- `frontend/` — Next.js 15 application
- `infra/` — infrastructure (Docker Compose, database init SQL)
- `docs/` — documentation

**Consequences**

- A single clone, single branch, and a single `docker compose up --build` brings up the
  whole system. API and UI changes ship together in one commit/PR.
- One `.gitignore` and one security boundary to reason about (see ADR-011).
- The trade-off is a larger repo and the lack of independent versioning/release cadence
  per component — acceptable while the project is a single-author, fast-moving v0.1.

---

## ADR-002: Postgres + pgvector as the single database, with two schemas (core vs results)

**Context**

The system needs to store relational metadata (projects, files, parsed documents, runs)
and also do vector similarity search over chunk embeddings. The naive option is to run a
relational database for metadata plus a dedicated vector store (e.g., a standalone vector
DB) for embeddings. That introduces a second piece of infrastructure, a second
consistency boundary, and the need to keep the two stores in sync.

**Decision**

Use a single PostgreSQL instance with the **pgvector** extension as both the relational
store and the vector store. Embeddings live in a `vector(384)` column on the `chunks`
table alongside their relational foreign keys, and similarity search is plain SQL
(`cosine_distance` with an HNSW index).

Organize the schema into two namespaces so concerns are cleanly separated:

- **`core`** — the inputs/configuration: `projects`, `files`, `parsed_documents`,
  `runs`, `run_combinations`.
- **`results`** — the outputs/measurements: `chunks` (with the `embedding vector(384)`
  column), `combination_stats`, `qa_pairs`, `retrievals`, `judge_evaluations`, `metrics`.

An HNSW index (`vector_cosine_ops`, `m=16`, `ef_construction=64`) is created on the
embedding column for fast approximate nearest-neighbor search.

**Consequences**

- One database to deploy, back up, and reason about. Vectors and their metadata are joined
  in a single query, with transactional consistency — no dual-write/sync problem.
- The `core`/`results` split makes it obvious which tables are configuration versus
  generated artifacts, and makes it easy to wipe/recompute results without touching inputs.
- Retrieval is expressed as ordinary SQL (`WHERE combination_id ... ORDER BY distance
  LIMIT k`), which keeps the retriever code simple.
- We are bound to Postgres + pgvector for vector search. At 384 dimensions and the data
  volumes of an evaluation tool, this is comfortably within pgvector's sweet spot; a
  dedicated vector store is not justified.

---

## ADR-003: arq (asyncio Redis queue) for background jobs

**Context**

A run executes a long, multi-stage pipeline: parse files, generate a QA set, chunk and
embed across many combinations, retrieve, judge with an LLM, and aggregate metrics. This
cannot block an HTTP request, so it must run on a background worker. The whole backend is
already async (SQLAlchemy 2 async + asyncpg, async LLM and embedding calls), and the
candidate queues are Celery, RQ, and arq.

**Decision**

Use **arq**, an asyncio-native Redis-backed task queue.

- The worker entrypoint is `app/workers/run_pipeline.py` (`run_pipeline(ctx, run_id)` and
  `parse_file_task(ctx, file_id)`).
- Configuration lives in `app/workers/settings.py` (`WorkerSettings`, `REDIS_SETTINGS`,
  `get_arq_pool`).
- The arq pool is created at app startup and stored on `app.state.arq`; routers enqueue
  jobs through it.

**Consequences**

- The worker runs the same `async def` code as the API — async DB sessions, async LLM
  calls, and async embedding all work without sync/async bridging. Celery's threading/
  multiprocessing model and RQ's fork model would have forced sync wrappers or a separate
  execution style.
- Redis is already in the stack (it also backs progress pub/sub — see ADR-010), so the
  queue adds no new infrastructure.
- The worker runs as a separate container from the **same image** with command
  `arq app.workers.settings.WorkerSettings`, so backend and worker share code and the
  model cache.
- arq has a smaller ecosystem than Celery (fewer built-in features like complex routing,
  rate limiting, or beat scheduling), but the pipeline's needs are simple enqueue/execute,
  so this is not a constraint.

---

## ADR-004: FastEmbed bge-small-en-v1.5 (384-dim, ONNX, CPU) + its HF tokenizer for honest token counts

**Context**

The tool embeds potentially many chunks per run across many combinations. Using a hosted
embedding API would add cost and latency per chunk and make local/offline development
painful. We need an embedding model that is cheap, fast on CPU, and small enough to ship in
a Docker image. We also need an honest token count for chunks so that token-based cost
comparisons are meaningful.

**Decision**

Use **FastEmbed** with the **BAAI/bge-small-en-v1.5** model:

- 384-dimensional embeddings (matching the `vector(384)` column and HNSW index).
- ONNX runtime, CPU-only — no GPU required.
- Embeddings are produced locally and are effectively free.

For token counting, use the **HuggingFace AutoTokenizer** that corresponds to the model,
with a **tiktoken fallback**. This gives token counts that reflect the actual tokenizer
rather than a rough heuristic.

The embedding model is configured via `EMBEDDING_MODEL` / `EMBEDDING_DIM`, accessed through
`app.core.embedding`, and the model cache (`hf_cache` volume) is shared between the backend
and worker containers.

**Consequences**

- Embedding is local, free, and reproducible — no API key or network needed to embed, and
  no per-chunk billing.
- The 384-dim choice propagates consistently to the schema and index; changing the model
  means changing `EMBEDDING_DIM` and recreating the index.
- Honest, tokenizer-accurate token counts make the notional embedding cost (ADR-007) a fair
  basis for dollar comparison across combinations.
- bge-small is a small model; for the relative comparison of chunking strategies (the goal
  of this tool) absolute retrieval quality matters less than consistency, so a light model
  is the right call. A heavier embedding model could be swapped in via config if needed.

---

## ADR-005: docling primary parser with pypdf/text fallback; CPU-only torch in the image

**Context**

Uploaded files (especially PDFs) must be turned into clean text before chunking. A naive
PDF text extractor handles simple documents but struggles with layout, tables, and
structure. **docling** produces much higher-quality structured text, but it depends on
`torch`, and installing torch by default pulls in the CUDA stack — hundreds of megabytes of
GPU libraries we do not use in a CPU-only deployment.

**Decision**

Use **docling as the primary parser**, with a **pypdf / plain-text fallback** when docling
fails or is not applicable.

In the backend Docker image (`Dockerfile.backend`), install **CPU-only torch first**, then
the rest of `requirements`, so docling resolves against the already-installed CPU torch and
does not drag in CUDA. Also install the system libraries docling needs (`libgl1`,
`libglib2.0-0`). Parsing runs in a thread (to avoid blocking the event loop) and the
resulting `ParsedDocument` is persisted so it is computed once per file.

**Consequences**

- High-quality parsing for the common case, with graceful degradation so a single
  problematic file does not break a run.
- The CPU-only torch install keeps the image substantially smaller and avoids shipping an
  unusable CUDA runtime.
- The `hf_cache` volume shared by backend and worker means model/tokenizer downloads happen
  once and are reused.
- docling is a relatively heavy dependency; the fallback path ensures the tool still
  functions even where docling cannot process a document.

---

## ADR-006: Groq llama-3.3-70b-versatile for QA generation, LLM-as-judge, and chat

**Context**

The evaluation pipeline needs an LLM in three places: (1) generating QA pairs to serve as
ground truth, (2) acting as a judge to score retrieved contexts, and (3) powering the
analyst chat over results. These call patterns benefit from a capable instruction-following
model with low latency and predictable cost.

**Decision**

Use the **Groq SDK** with the **llama-3.3-70b-versatile** model for all three roles.

- QA generation: `qa_generator.generate_qa_pairs` calls Groq with `QA_GENERATOR_PROMPT`.
- Judging: `judge.judge` calls Groq with `JUDGE_PROMPT` at **temperature 0** for
  deterministic scoring, and captures token usage from `response.usage`.
- Chat: `chat.py` streams responses using `CHAT_SYSTEM_PROMPT`.

All LLM access goes through `app.core.llm.get_llm()`; prompts live in
`app/prompts/prompt_texts.py`. The model is configured via `GROQ_MODEL`.

**Consequences**

- A single provider/model for every LLM task simplifies configuration, prompting, and cost
  accounting. There is one place (`get_llm()`) to change the provider.
- Groq's fast inference keeps the judging stage (one LLM call per QA per combination)
  tractable for runs with many combinations.
- Real token usage from `response.usage` feeds the real Groq cost calculation (ADR-007).
- Temperature 0 for the judge makes scores reproducible across re-runs.
- The dependency on Groq requires a `GROQ_API_KEY`; this is the only external service the
  tool needs, and it is kept out of git (ADR-011).

---

## ADR-007: Notional embedding cost + real Groq judge cost, so combinations are dollar-comparable

**Context**

To compare chunking combinations on a cost/quality trade-off, each combination needs a
dollar figure. But the embedding step is local and therefore free, which would make every
combination's embedding cost zero and hide the fact that combinations that produce more (or
larger) chunks consume more embedding work. The judge step, by contrast, has a genuine
dollar cost from the Groq API.

**Decision**

Compute cost in `app/core/pricing.py` as the sum of two parts:

- **Embedding cost (notional):** `total_tokens / 1000 * EMBED_COST_PER_1K`. Because local
  embeddings are free, this is a *notional* price applied to token volume purely so that
  combinations remain dollar-comparable — a combination that embeds more tokens shows a
  higher (notional) embedding cost.
- **Groq cost (real):** `prompt_tokens / 1e6 * GROQ_INPUT_COST_PER_M + completion_tokens /
  1e6 * GROQ_OUTPUT_COST_PER_M`, derived from the actual `response.usage` returned by Groq.

`total_cost = embedding_cost + judge_cost`.

**Consequences**

- Every combination gets a meaningful, comparable dollar number even though embeddings are
  free — the cost-vs-accuracy trade-off analytics have a real x-axis.
- The notional rate is configurable (`EMBED_COST_PER_1K`) so it can be tuned to reflect a
  hypothetical hosted embedding price.
- The judge cost is genuinely accurate, reflecting real Groq spend.
- Users must understand that the embedding component is a proxy, not a billed amount; this
  is documented as "notional" in the pricing module.

---

## ADR-008: Auto-generated QA ground truth + text-overlap relevance for computed IR metrics

**Context**

To compute information-retrieval metrics (precision@k, recall@k, MRR, nDCG, F2) we need
ground truth: which chunk(s) should be retrieved for a given question. Hand-labeling
relevance for every document is infeasible for an automated tool, and we want metrics that
can be computed for arbitrary uploaded corpora without human annotation.

**Decision**

Generate ground truth automatically and define relevance by **text overlap**:

- `qa_generator.generate_qa_pairs(text, n)` samples `n` evenly-spaced ~900-character
  passages and asks Groq to extract a `{question, reference_answer}` from each. The source
  passage is stored as the **gold passage** along with its character offsets.
  (`QA_PAIRS_PER_FILE` controls `n`.)
- In `metrics.py`, the gold passage is the ground truth. A retrieved chunk counts as
  **relevant** if it is from the same file **and** the word-set overlap with the gold
  passage meets a threshold: `|gold ∩ chunk| / |gold| >= 0.5`.
- Per query we compute precision@k, recall@k (binary, single gold), MRR, nDCG@k (binary),
  and F2; results are then **macro-averaged** across queries.

A **single shared QA set** is generated once per run and reused across all combinations so
they are compared on identical questions.

**Consequences**

- Fully automated, no human labeling — the tool works on any uploaded corpus out of the
  box.
- Storing gold passage offsets ties each question to a concrete region of source text,
  which makes the overlap-based relevance check possible and explainable.
- Using one shared QA set per run is essential for fair comparison: every combination is
  scored against the same questions.
- The 0.5 word-overlap threshold and binary single-gold model are heuristics; they yield
  consistent *relative* rankings of combinations (the goal) rather than absolute
  publication-grade IR scores. This complements the separate LLM-as-judge scores
  (relevance, faithfulness, context precision/recall) from ADR-006.

---

## ADR-009: Startup idempotent DB bootstrap instead of Alembic for v0.1

**Context**

The database needs the pgvector extension, two schemas, a set of tables across both
schemas, and an HNSW index. A typical production approach is a migration tool such as
Alembic. But during early development the schema changes often, and the overhead of
authoring and ordering migrations slows iteration. The deployment model is also simple
(fresh `docker compose up`).

**Decision**

For v0.1, bootstrap the database **idempotently at application startup** rather than using
Alembic. `app/db/setup_db.py` `init_db()` runs in the `main.py` lifespan and performs:

- `CREATE EXTENSION` for `vector`
- `CREATE SCHEMA` for `core` and `results`
- `create_all` for both metadatas
- `CREATE INDEX` for the HNSW index (`embedding vector_cosine_ops`, `m=16`,
  `ef_construction=64`)

All steps are written to be safe to run repeatedly. The Docker `init.sql` additionally
mounts the extension and schema creation at the Postgres container level.

**Consequences**

- Bringing up the stack requires no separate migration step — startup is self-sufficient,
  and re-running it is harmless.
- Fast iteration on the schema during early development without writing migrations.
- The cost is that there is **no migration history and no in-place schema evolution**:
  changing an existing table's shape is not handled by `create_all`. This is acceptable for
  v0.1 where data is disposable; introducing **Alembic is the expected next step** once the
  schema stabilizes and migrations on existing data become necessary.

---

## ADR-010: SSE (native EventSource) for progress, fetch ReadableStream for chat

**Context**

Two features need to stream data from server to browser: live run progress (the pipeline
emits many small status updates as it works) and chat responses (token-by-token LLM
output). WebSockets are an option but are bidirectional and heavier than needed; both of
these flows are essentially one-directional server→client streams.

**Decision**

Use two streaming mechanisms suited to each flow:

- **Progress: Server-Sent Events (SSE)** via the browser's native `EventSource`. The
  backend publishes events to a Redis pub/sub channel `run:{id}:progress` and also keeps a
  snapshot hash `run:{id}:state`. `GET /runs/{id}/progress/stream` (an `EventSourceResponse`)
  first replays the state hash so a late subscriber catches up, then streams live pub/sub
  events. Event types are `run`, `combo`, `file`, and `log`. Progress is also denormalized
  onto the `Run`/`RunCombination` rows so a plain `GET /runs/{id}/progress` snapshot works
  without subscribing.
- **Chat: `fetch` + `ReadableStream`.** `POST /chat/stream` returns a `text/plain` token
  stream which the frontend consumes via the fetch Response body's `ReadableStream`.

**Consequences**

- Progress uses the right tool: SSE is purpose-built for server-push event streams, and
  native `EventSource` handles reconnection automatically. The "replay state hash, then
  stream" pattern means a client that connects mid-run immediately sees current state.
- Denormalizing progress onto the rows gives a cheap polling/snapshot path and makes
  progress durable beyond the pub/sub channel's lifetime.
- Chat is a `POST` carrying a request body (message, history, scope), which native
  `EventSource` (GET-only) cannot do; the fetch + `ReadableStream` approach handles the POST
  body and streams the response, which is the natural fit.
- Two streaming styles to maintain, but each matches its use case (event stream vs. POST
  token stream) better than forcing both through one mechanism or adopting WebSockets.

---

## ADR-011: Private standalone git repo, with the API key kept out of git

**Context**

The project uses a real Groq API key. The key was copied locally from another project
(`mindmate_proj/.env`) into chunklab's `.env`. A leaked key in git history is a real
security incident, and chunklab is an early-stage personal project rather than a public
open-source release.

**Decision**

Keep chunklab in its own **private standalone git repository**, and keep secrets out of git
entirely:

- All configuration is read through `app.core.config.Settings`; the real `.env` is never
  committed.
- `.gitignore` excludes `.env`, `.env.*`, `*.key`, and `*.pem`, while explicitly
  re-including `!.env.example`. Only `.env.example` (placeholders only) is tracked.
- The real `.env` containing the Groq key was created locally and never committed.
- A **verification gate** is required before any `git add`:
  - `git check-ignore -v .env` must confirm `.env` is ignored, and
  - `git ls-files | grep .env` must return nothing (no `.env` is tracked).

**Consequences**

- The secret never enters git history; even a `git add -A` is guarded by the ignore rules,
  and the verification gate catches mistakes before they are committed.
- `.env.example` documents every required variable with placeholder values, so a new
  checkout knows exactly what to fill in without ever seeing real secrets.
- The repo being private adds defense in depth, but the primary protection is the gitignore
  + verification gate, which would hold even if the repo were later made public.
- Contributors must follow the verification gate discipline; it is cheap (two commands) and
  prevents the most common secret-leak mistake.
