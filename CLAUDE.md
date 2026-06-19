# CLAUDE.md — chunklab

chunklab is a full-stack tool for **evaluating and comparing text-chunking
strategies for RAG**. Create a project, upload documents, pick a combinatorial
matrix of chunking strategies, and run an experiment: each file is parsed,
chunked per combination, embedded, token-counted, cost-estimated, stored in
pgvector, then scored for retrieval accuracy by an LLM-as-judge over
auto-generated QA pairs. Results drive analytics and a RAG chatbot.

## Commands
```bash
# whole stack
docker compose up --build              # postgres+pgvector, redis, backend, worker, frontend
docker compose exec backend python -m app.scripts.seed   # sample project + doc

# backend (local)
python -m pytest backend/tests -v      # unit tests (pure logic, no services needed)
ruff check backend/app backend/tests

# frontend (local)
cd frontend && npm install && npm run build
```
Ports: **3000** frontend · **8000** backend · **5432** postgres · **6379** redis.

## Architecture
- **backend/** — FastAPI (async). API under `/api/v1`. Heavy work runs in an
  **arq** worker (Redis queue), not request handlers.
- **frontend/** — Next.js 15 (App Router) + TypeScript + Tailwind + TanStack
  Query + Recharts. Live progress via native `EventSource` (SSE); chat via
  `fetch` + `ReadableStream`.
- **Postgres, two schemas**: `core` (projects, files, parsed_documents, runs,
  run_combinations) and `results` (chunks+`vector(384)`, combination_stats,
  qa_pairs, retrievals, judge_evaluations, metrics).
- **Models**: embeddings = FastEmbed `BAAI/bge-small-en-v1.5` (384-dim); LLM =
  Groq `llama-3.3-70b-versatile` (QA gen, judge, chat).

## Key conventions (follow these)
- Settings ONLY via `app.core.config.get_settings()`. Never read env elsewhere.
- LLM access ONLY via `app.core.llm.get_llm()`. Prompts ONLY in
  `app/prompts/prompt_texts.py`.
- Embeddings/tokenizer ONLY via `app.core.embedding`.
- All DB and LLM calls are **async**. The pgvector embedding dimension is **384**
  and must match `EMBEDDING_DIM`.
- New chunking strategy = a class implementing `split()`+`label()` in
  `app/services/chunking/`, calling `register(...)`. It auto-appears in runs;
  add a matching entry to `frontend/src/lib/strategies.ts` for the UI.
- New API endpoint = a router under `app/api/routers/`, included in `main.py`
  under `/api/v1`.
- Schema/table changes: edit `app/db/models_*.py`; `app/db/setup_db.py`
  (`init_db`) creates everything idempotently at startup (no Alembic in v0.1).

## Editing workflow
- When making **independent edits across multiple files**, dispatch them to
  **subagents in parallel** (one Agent per file/area) instead of editing
  sequentially — it's faster and keeps each change self-contained. Keep edits
  single-threaded only when they must happen in a specific order or share state.

## Secrets
The real Groq key lives in a **gitignored `.env`** (copied from `.env.example`).
NEVER commit `.env` or hardcode keys. The repo is private. See `docs/SECURITY.md`.

## Git / commit conventions
- **Never** add `Co-Authored-By` trailers to commits, and **never** mention Claude/AI/assistant
  tooling in commit messages or PR descriptions. Write commits as the author.
- Commit only when asked; branch off `main` for non-trivial work; never commit `.env`.

## Where things are
- Run pipeline: `app/workers/run_pipeline.py` · progress: `app/workers/progress.py`
- Eval: `app/services/eval/{qa_generator,retriever,judge,metrics}.py`
- Report builder (results+analytics+chat): `app/services/reporting.py`
- Product assistant (`about` chat scope): knowledge base `backend/app/knowledge/*.md`
  → embedded into `results.doc_chunks` by `app/services/docs/knowledge.py` (chunklab's
  own RAG, dogfooded). Refresh: `docker compose exec backend python -m app.scripts.ingest_docs`.
- Frontend builder screen: `frontend/src/app/projects/[projectId]/runs/new/page.tsx`
- More detail: `docs/` and `backend/CLAUDE.md`, `frontend/CLAUDE.md`.
