# chunklab 🧪

**Evaluate and compare text-chunking strategies for RAG.**

chunklab lets you create a project, upload documents, and run *experiments* that
compare many chunking strategies head-to-head. For every strategy × parameter
combination it parses your files, chunks them, embeds the chunks, counts tokens,
estimates cost, stores everything in pgvector, and then scores **retrieval
accuracy** with an LLM-as-judge over auto-generated QA pairs. You get charts,
a comparison table, and a RAG chatbot to interrogate the results.

![stack](https://img.shields.io/badge/FastAPI-009688) ![next](https://img.shields.io/badge/Next.js%2015-000000) ![pg](https://img.shields.io/badge/Postgres%20%2B%20pgvector-336791) ![groq](https://img.shields.io/badge/Groq-F55036)

---

## Features
- **Projects & files** — upload PDFs / markdown / text; parsed with **docling** (pypdf/text fallback).
- **Combinatorial run builder** — sentence, character, recursive, token, and semantic strategies, each with size/overlap params; assemble a matrix and launch.
- **Background processing** — Redis-backed **arq** worker with **live progress bars** (SSE).
- **Light embeddings + real tokenizer** — FastEmbed `BAAI/bge-small-en-v1.5` (384-dim) and the model's own tokenizer for honest token counts.
- **LLM-as-judge evaluation** — Groq auto-generates QA pairs, then scores relevance / faithfulness / context-precision / recall, alongside computed **precision@k, recall@k, MRR, nDCG, F2**.
- **Cost & token tracking** — notional embedding rate + real Groq judge cost.
- **Analytics** — accuracy bars, cost-vs-accuracy scatter, KPI cards, sortable comparison table, run-vs-run compare.
- **Chatbot** — chat over a project, a single run, or a comparison of two runs; results are the RAG context.

## Architecture
```
Next.js (3000) ──HTTP/SSE──> FastAPI (8000) ──> Postgres + pgvector (5432)
                                  │
                                  └── enqueue ──> Redis (6379) ──> arq worker
                                                     (parse → chunk → embed → store → evaluate)
Embeddings: FastEmbed bge-small (384d)   LLM: Groq llama-3.3-70b-versatile
```
Two Postgres schemas keep app data (`core`) separate from experiment output (`results`).

## Quickstart
```bash
# 1. configure secrets (never commit .env)
cp .env.example .env
#   then set GROQ_API_KEY=... in .env  (free key at https://console.groq.com)

# 2. launch everything
docker compose up --build

# 3. seed a sample project (optional)
docker compose exec backend python -m app.scripts.seed

# 4. open the app
open http://localhost:3000
```

Then: create a project → upload a file → **New run** → add a few combinations
(e.g. `sentence·512/20`, `recursive·512/64`, `semantic·pct95`) → **Launch** →
watch progress → explore the analytics → ask the chatbot.

## Documentation
| Doc | What |
|-----|------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System + data flow |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Schemas, tables, pgvector |
| [docs/CHUNKING.md](docs/CHUNKING.md) | Strategies & params |
| [docs/EVALUATION.md](docs/EVALUATION.md) | QA gen, judge, metrics |
| [docs/API.md](docs/API.md) | REST endpoints |
| [docs/SETUP.md](docs/SETUP.md) | Local & docker setup |
| [docs/SECURITY.md](docs/SECURITY.md) | Secret handling |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Architecture decisions |
| [docs/implementation.html](docs/implementation.html) | Full implementation writeup |

## Tech stack
FastAPI · SQLAlchemy 2 (async) · asyncpg · pgvector · arq · FastEmbed · docling ·
Groq · Next.js 15 · TanStack Query · Recharts · Tailwind · Docker Compose.

> ⚠️ **Never commit `.env`.** It holds your Groq API key. The repo is private and
> `.env` is gitignored; see `docs/SECURITY.md`.
