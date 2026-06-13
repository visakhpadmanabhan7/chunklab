# chunklab — Setup & Run Guide

chunklab is a tool for evaluating and comparing text-chunking strategies for RAG
pipelines. This guide covers two ways to run it — **Docker (recommended)** and
**local development** — plus how to run the tests and a troubleshooting section.

The repo is a monorepo:

```
chunking_exp/
├── backend/    FastAPI API + arq worker (Python 3.11)
├── frontend/   Next.js 15 App Router (TypeScript)
├── infra/      postgres init.sql, etc.
└── docs/        this guide
```

There are five moving parts:

| Component | What it does | Port |
| --------- | ------------ | ---- |
| `frontend` | Next.js UI | **3000** |
| `backend`  | FastAPI API (`/api/v1`, `/health`) | **8000** |
| `worker`   | arq worker that runs the chunking/eval pipeline | — |
| `postgres` | Postgres 16 + pgvector (schemas `core`, `results`) | **5432** |
| `redis`    | arq job queue + live-progress pub/sub | **6379** |

---

## Prerequisites

Common to both paths:

- A **Groq API key** — sign up free at <https://console.groq.com>. The LLM
  (model `llama-3.3-70b-versatile`) is used for QA-pair generation and as the
  judge. **Embeddings are local and free** (FastEmbed `BAAI/bge-small-en-v1.5`,
  384-dim), so no embedding provider key is needed.

For Docker:

- Docker + Docker Compose v2 (`docker compose ...`).

For local dev:

- Python **3.11+**
- Node.js **22+** (Next.js 15 / React 19)
- A local **Postgres 16 with the `pgvector` extension** available
- A local **Redis 7+**

---

## 1. Docker (recommended)

This brings up all five services with one command. Postgres has pgvector
preinstalled (`pgvector/pgvector:pg16`) and the embedding/tokenizer models are
cached in a shared volume.

### 1.1 Configure the environment

```bash
cp .env.example .env
```

Open `.env` and set your Groq key — this is the **only** value you must change:

```dotenv
GROQ_API_KEY=gsk_your_real_key_here
```

Everything else in `.env.example` has working defaults. A few notes:

- `DATABASE_URL` and `REDIS_URL` in `.env` point at the docker service names
  (`postgres`, `redis`). **In Docker, compose overrides these anyway** (see the
  `environment:` blocks in `docker-compose.yml`), so the in-container values are
  always correct. You only need to change them for **local dev** (see §2).
- Cost knobs (`EMBED_COST_PER_1K`, `GROQ_INPUT_COST_PER_M`,
  `GROQ_OUTPUT_COST_PER_M`), `TOP_K`, and `QA_PAIRS_PER_FILE` can be left as-is.

> **Security:** the real `.env` is gitignored. Never commit it. `.env.example`
> contains placeholders only.

### 1.2 Bring everything up

```bash
docker compose up --build
```

What happens:

1. **postgres** boots. On first boot it runs `infra/postgres/init.sql`
   (`CREATE EXTENSION vector` + `CREATE SCHEMA core/results`) and passes a
   `pg_isready` healthcheck.
2. **redis** boots and passes a `redis-cli ping` healthcheck.
3. **backend** builds from `Dockerfile.backend` and starts uvicorn on `:8000`.
   On startup, `app.db.setup_db.init_db()` runs the idempotent bootstrap:
   it ensures the `vector` extension, the `core` and `results` schemas,
   creates all tables for both schema metadatas, and creates the HNSW index on
   `results.chunks.embedding` (`vector_cosine_ops`, `m=16`,
   `ef_construction=64`). There is **no Alembic migration step** in v0.1 — this
   startup bootstrap replaces it. The backend waits for postgres + redis to be
   healthy first, then exposes `GET /health`.
4. **worker** builds from the **same image** as the backend and runs
   `arq app.workers.settings.WorkerSettings`. It consumes jobs (`parse_file_task`
   for uploads, `run_pipeline` for runs) and publishes progress to Redis.
5. **frontend** builds from `Dockerfile.frontend` (Next.js standalone output)
   with the build arg `NEXT_PUBLIC_API_BASE_URL=http://localhost:8000` baked in
   (this URL is what the **browser** uses to reach the API), and starts on
   `:3000` once the backend is healthy.

#### First-run model download

On the **first** run the backend/worker download the embedding model and
tokenizer from Hugging Face / FastEmbed, and docling downloads its parsing
models on first use. This can take **a few minutes** and needs network access.

- These caches live at `/root/.cache` inside the container, mounted as the
  **shared `hf_cache` volume** so the backend and worker **share one download**
  (and reuse it across restarts). `HF_HOME` and `FASTEMBED_CACHE_PATH` point
  there.
- Until the model finishes downloading, the first request that needs embeddings
  (e.g. starting a run) will appear to hang. Subsequent runs are fast.

> Tip: to pre-warm the cache, you can run the prefetch script (it also runs the
> docling download): `docker compose exec worker python -m app.scripts.prefetch_models`

### 1.3 Seed a sample project

In another terminal (with the stack running), seed a sample project + parsed
document so the UI is immediately usable:

```bash
docker compose exec backend python -m app.scripts.seed
```

### 1.4 Open the app

Open <http://localhost:3000>.

- UI: <http://localhost:3000>
- API: <http://localhost:8000/api/v1>
- Health: <http://localhost:8000/health>

### Volumes

`docker-compose.yml` declares four named volumes (data survives
`docker compose down`; remove with `docker compose down -v`):

| Volume | Mounted in | Purpose |
| ------ | ---------- | ------- |
| `pgdata`   | postgres | Postgres data directory |
| `redisdata`| redis    | Redis persistence |
| `uploads`  | backend, worker | Uploaded files (`STORAGE_DIR=/app/data/uploads`), shared so the worker can parse what the API saved |
| `hf_cache` | backend, worker | Shared model cache (embedding + tokenizer + docling) |

---

## 2. Local development (without Docker)

Run the services on your host. You still need a **Postgres with pgvector** and a
**Redis** reachable from your machine — the easiest hybrid is to run *only*
those two in Docker and run the Python/Node code locally:

```bash
docker compose up -d postgres redis
```

(Or use your own local Postgres 16 + pgvector and Redis 7.)

### 2.1 Point the env at localhost

For local runs the service names `postgres` / `redis` don't resolve — you must
use `localhost`. In your shell (or a local `.env`):

```bash
export DATABASE_URL="postgresql+asyncpg://chunklab:chunklab@localhost:5432/chunklab"
export REDIS_URL="redis://localhost:6379/0"
export GROQ_API_KEY="gsk_your_real_key_here"
export STORAGE_DIR="./data/uploads"   # any writable local dir
```

> If you used your own Postgres (not the docker one), make sure the `vector`
> extension is installed and the `core` / `results` schemas can be created.
> The backend's `init_db()` will attempt `CREATE EXTENSION vector` on startup,
> which requires a superuser the first time. With the `pgvector/pgvector:pg16`
> image (or the docker postgres above) this is already handled.

### 2.2 Backend (FastAPI)

From the repo root:

```bash
python -m venv .venv
source .venv/bin/activate           # Windows: .venv\Scripts\activate
pip install -r backend/requirements.txt
```

> Note: `backend/requirements.txt` lists `torch` indirectly via `docling`. On a
> CPU-only machine, install CPU torch first to avoid pulling the multi-GB CUDA
> build:
> `pip install torch --index-url https://download.pytorch.org/whl/cpu`

Run the API (the app lives in `backend/app`, importable via `--app-dir`):

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 --app-dir backend
```

On startup it runs the same `init_db()` bootstrap against your `DATABASE_URL`.
Check it: <http://localhost:8000/health>.

### 2.3 Worker (arq)

The pipeline (parsing, chunking, embedding, evaluation) runs in the arq worker —
the API only enqueues jobs. Run it in a separate terminal **with the same
environment** (same `DATABASE_URL`, `REDIS_URL`, `GROQ_API_KEY`):

```bash
source .venv/bin/activate
cd backend
arq app.workers.settings.WorkerSettings
```

Without the worker running, uploads won't be parsed and runs will stay queued.

### 2.4 Frontend (Next.js)

The browser needs to know where the API is. For local dev that's
`http://localhost:8000` (the default), but you can set it explicitly:

```bash
cd frontend
npm install
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000 npm run dev
```

Open <http://localhost:3000>.

To do a production-style build locally (the same `next build` CI runs):

```bash
cd frontend
npm run build
```

### 2.5 Seed (optional)

With the backend env active:

```bash
cd backend
python -m app.scripts.seed
```

---

## 3. Running tests

Backend tests live in `backend/tests/` (chunking, config, metrics, pricing).
From the repo root, with the backend deps installed:

```bash
python -m pytest backend/tests -v
```

Frontend has no test suite in v0.1; the build itself is the gate:

```bash
cd frontend && npm run build
```

---

## 4. Troubleshooting

### First run is slow / appears to hang
The embedding model, tokenizer, and docling models download on first use (see
§1.2). This can take a few minutes and needs internet access. Watch the
backend/worker logs (`docker compose logs -f worker`). Once cached in the
`hf_cache` volume, later runs are fast. Pre-warm with
`docker compose exec worker python -m app.scripts.prefetch_models`.

### `extension "vector" is not available` / pgvector errors
The pgvector extension must exist in the database. In Docker this is guaranteed
by the `pgvector/pgvector:pg16` image plus `infra/postgres/init.sql`. For a
**local, non-docker Postgres**, install the pgvector extension package and
ensure the role used by `DATABASE_URL` can `CREATE EXTENSION vector` (superuser
the first time). Re-running the backend triggers the idempotent bootstrap again.

### Port already in use (3000 / 8000 / 5432 / 6379)
Another process is bound to that port. Find and stop it, e.g.:

```bash
lsof -i :8000        # or :3000, :5432, :6379
```

For Docker, you can remap the host side in `docker-compose.yml` (e.g.
`"8001:8000"`) — but if you change the **frontend → backend** port, also update
the `NEXT_PUBLIC_API_BASE_URL` build arg, since it's inlined at build time and
the browser uses it directly.

### Frontend loads but API calls fail (CORS or connection refused)
- `NEXT_PUBLIC_API_BASE_URL` is baked in at **build time**. If you change the
  backend URL/port, rebuild the frontend (`docker compose build frontend` or
  re-run `npm run build`).
- `CORS_ORIGINS` (default `http://localhost:3000`) must include the origin the
  browser is served from. Update it in `.env` if you serve the UI elsewhere.

### Runs never progress past "queued"
The **worker** isn't running or can't reach Redis/Postgres. In Docker, check
`docker compose ps` and `docker compose logs -f worker`. Locally, make sure
you started the arq worker (§2.3) with the same `REDIS_URL` / `DATABASE_URL` as
the API.

### `GROQ_API_KEY` missing / 401 from Groq
QA generation and judging call Groq. Set a valid key in `.env` (Docker) or your
shell (local). Restart the backend **and** worker after changing it.

### Live progress (SSE) not updating
Progress streams from `GET /api/v1/runs/{id}/progress/stream` (Server-Sent
Events) backed by Redis pub/sub. If it's stuck, confirm Redis is healthy and the
worker is publishing (`docker compose logs -f worker`). Some proxies buffer SSE;
hit the backend directly on `:8000` to rule that out.
