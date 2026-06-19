# Setup & tech stack

How to run chunklab and what it is built from. This covers the Docker
quickstart, secrets/configuration, local-development commands, the full backend
and frontend stack, the models in use, and how this product-assistant knowledge
base itself is ingested. For what chunklab does see `00_what_is_chunklab.md`;
for the database layout see `02_data_model.md`.

## Quickstart with Docker

Docker Compose is the recommended way to run the whole stack. One command builds
and starts all five services: **postgres** (with the pgvector extension),
**redis**, **backend** (FastAPI), **worker** (arq), and **frontend**
(Next.js).

```bash
# 1. configure secrets (never commit .env)
cp .env.example .env
#    then set GROQ_API_KEY=... in .env

# 2. launch everything
docker compose up --build

# 3. seed a sample project (optional)
docker compose exec backend python -m app.scripts.seed

# 4. open the app
open http://localhost:3000
```

On first boot postgres runs `infra/postgres/init.sql` (creates the `vector`
extension and the `core` / `results` schemas). The backend's startup
`init_db()` then idempotently creates all tables and the HNSW index — there is
**no Alembic migration step** in v0.1. The first run also downloads the
embedding model, tokenizer, and docling parsing models from Hugging Face into a
shared cache volume; this can take a few minutes and needs network access. You
can pre-warm it with
`docker compose exec worker python -m app.scripts.prefetch_models`.

## Host ports

Compose maps each service to a host port (the in-container ports differ; see
`docker-compose.yml`):

| Service | Host port | In-container port |
| ------- | --------- | ----------------- |
| frontend | **3000** | 3000 |
| backend  | **8001** | 8000 |
| postgres | **5433** | 5432 |
| redis    | **6380** | 6379 |

The browser reaches the API via the `NEXT_PUBLIC_API_BASE_URL` build arg, baked
into the frontend image as `http://localhost:8001`. Inside the compose network,
services talk to each other by name (`postgres:5432`, `redis:6379`,
`backend:8000`), so the host-side remap does not affect inter-service traffic.

- UI: <http://localhost:3000>
- API: <http://localhost:8001/api/v1>
- Health: <http://localhost:8001/health>

Four named volumes persist data across `docker compose down` (remove with
`docker compose down -v`): `pgdata` (Postgres), `redisdata` (Redis), `uploads`
(uploaded files, shared between backend and worker), and `hf_cache` (shared
model cache).

## Configuration & secrets (.env)

All configuration is read through `app.core.config.get_settings()`; code never
reads environment variables directly. Configure by copying the template and
editing it:

```bash
cp .env.example .env
```

The **only** value you must set is your Groq API key:

```dotenv
GROQ_API_KEY=gsk_your_real_key_here
```

Everything else in `.env.example` has working defaults: the embedding model and
dimension (`EMBEDDING_MODEL`, `EMBEDDING_DIM=384`), `DATABASE_URL`,
`REDIS_URL`, Postgres credentials, retrieval/eval knobs (`TOP_K`,
`QA_PAIRS_PER_FILE`, `MAX_QA_PAIRS_PER_RUN`), the cost model
(`EMBED_COST_PER_1K`, `GROQ_INPUT_COST_PER_M`, `GROQ_OUTPUT_COST_PER_M`), and
`CORS_ORIGINS` (default `http://localhost:3000`).

**Secrets convention:** the real `.env` is **gitignored and must never be
committed** — it holds your Groq key. `.env.example` contains placeholders only.
In Docker, compose overrides `DATABASE_URL` and `REDIS_URL` to point at the
service names, so the in-container values are always correct regardless of what
the `.env` says. You only need to adjust those for local development.

## Local development

You can run the services directly on your host instead of in containers. You
still need a Postgres with pgvector and a Redis reachable from your machine; the
easiest hybrid is to run only those two in Docker:

```bash
docker compose up -d postgres redis
```

Point the environment at `localhost` (the service names `postgres` / `redis` do
not resolve outside the compose network), then run each piece.

**Backend (FastAPI):** the app lives in `backend/app`, imported via `--app-dir`.

```bash
uvicorn app.main:app --app-dir backend --reload
```

**Worker (arq):** required for uploads to be parsed and runs to progress — the
API only enqueues jobs. Run it with the same environment as the API:

```bash
arq app.workers.settings.WorkerSettings   # cwd=backend, or set PYTHONPATH=backend
```

**Frontend (Next.js):**

```bash
cd frontend
npm install
npm run dev      # http://localhost:3000
npm run build    # production build (Next standalone in Docker)
```

The frontend reads `NEXT_PUBLIC_API_BASE_URL` (default `http://localhost:8000`
for local dev); set it in `.env.local` if your backend is elsewhere.

**Tests & lint:** backend tests are pure logic and need no running services.

```bash
python -m pytest backend/tests -v
ruff check backend/app backend/tests
```

There is no frontend test suite in v0.1; `npm run build` is the gate.

## Backend stack

The backend is **FastAPI** (async), with all heavy work pushed to an **arq**
worker over a Redis queue rather than running in request handlers.

- **Web:** FastAPI, uvicorn, `python-multipart` (file uploads), `sse-starlette`
  (Server-Sent Events for live progress), `slowapi` (rate limiting).
- **Data layer:** SQLAlchemy 2 (async), `asyncpg`, `pgvector`, `greenlet`. Two
  Postgres schemas — `core` and `results` — with the chunk embedding column
  typed `vector(384)`.
- **Jobs & cache:** `arq` (Redis-backed task queue) and `redis`.
- **Embeddings & tokenizing:** `fastembed` (the local embedding model),
  `transformers` + `tokenizers` for the model's own tokenizer, with `tiktoken`
  as a fallback for honest token counts.
- **Chunking:** `langchain` / `langchain-text-splitters` /
  `langchain-experimental` and `llama-index-core` provide the splitter
  primitives behind the chunking strategies.
- **Parsing:** `docling` (primary, multi-format) with `pypdf` / plain-text
  fallback.
- **LLM SDKs:** `groq` (default provider), plus `openai` and `anthropic` for
  optional bring-your-own-key providers.
- **Config & misc:** `pydantic`, `pydantic-settings`, `python-dotenv`, `numpy`.

LLM access goes only through `app.core.llm.get_llm()`, embeddings/tokenizer only
through `app.core.embedding`, and prompts live only in
`app/prompts/prompt_texts.py`.

## Frontend stack

The frontend is **Next.js 15** (App Router) on **React 19** with TypeScript.

- **Framework:** Next.js 15, React 19, TypeScript.
- **Styling:** Tailwind CSS (v3) with PostCSS / Autoprefixer.
- **Server state:** TanStack Query (`@tanstack/react-query`).
- **Client/draft state:** Zustand (the run-builder combination matrix).
- **Charts:** Recharts (accuracy bars, cost-vs-accuracy scatter, comparisons).
- **Icons / utils:** `lucide-react`, `clsx`.

Live run progress uses the native `EventSource` (SSE); chat uses `fetch` +
`ReadableStream` to read a streamed token response.

## Models

- **Embeddings:** FastEmbed `BAAI/bge-small-en-v1.5`, **384-dimensional**, run
  **locally and free** — no embedding provider key is required. The pgvector
  dimension and `EMBEDDING_DIM` must both equal 384.
- **LLM (default):** **Groq** `llama-3.3-70b-versatile`, used for QA-pair
  generation, the LLM-as-judge, and chat. (`.env.example` ships
  `llama-3.1-8b-instant` as a friendlier free-tier default; the 70B model is
  higher quality.)
- **Optional LLMs:** OpenAI and Anthropic SDKs are installed for optional
  bring-your-own-key use; Groq is the default and the only one needed to run the
  product.

## The product-assistant knowledge base

This document is part of the product-assistant knowledge base — curated markdown
files in `backend/app/knowledge/` numbered `00`–`10`. At startup these files are
embedded (with the same FastEmbed model) and stored in `results.doc_chunks`,
which the in-app assistant retrieves over.

To refresh the knowledge base after editing these files (force re-ingest):

```bash
docker compose exec backend python -m app.scripts.ingest_docs
```

See `06_chat_and_product_assistant.md` for how the assistant uses these chunks,
and `10_faq.md` for common questions.
