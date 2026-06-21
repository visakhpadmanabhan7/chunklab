# ChunkLab — Blog Plan

The base plan for writing about ChunkLab. One overarching **theme**, a **series**
of posts that ladder up to it, a reusable **per-post template** (`_TEMPLATE.md`),
and the **conventions / publishing** notes at the bottom.

---

## Theme

> **"Chunking is an untuned hyperparameter — so I built the benchmark for it,
> in the open."**

Every RAG tutorial picks a chunk size (512? 1000? overlap 10%?) and moves on.
Nobody measures whether that choice was good — there's no A/B harness for it.
ChunkLab is that harness: define a *matrix* of chunking strategies, run them over
your documents, and get retrieval accuracy (LLM-as-judge + IR metrics) plotted
against token cost so you can pick the point on the Pareto frontier you actually
want.

The series sells that idea two ways at once:
- **the product** — why this matters and what it shows (for RAG practitioners), and
- **the build** — the engineering decisions and the bugs that taught them
  (for backend / full-stack / infra readers).

Both angles point at the same open-source repo, so every post ends with a "clone
it / try it / read the code" CTA.

---

## The series

Numbered by suggested publish order. Each can stand alone; together they tell the
whole story. **Lead with #1 and #3** — they have the widest reach.

### 1. Your chunking strategy is an untuned hyperparameter *(flagship / intro)*
- **Angle:** product + problem. The hook everyone clicks.
- **Audience:** anyone building RAG.
- **Core:** the problem (chunking choices are guesses), the idea (benchmark the
  matrix), a 90-second tour (project → upload → matrix → run → cost-vs-accuracy
  Pareto), and one real finding from a run.
- **Assets:** the cost-vs-nDCG scatter screenshot; the run-builder matrix; a
  short results table.
- **Source:** `docs/overview.html`, `README.md`, `backend/app/knowledge/00_*`.

### 2. How do you actually *score* a chunking strategy? *(methodology deep-dive)*
- **Angle:** methodology. The credibility post.
- **Audience:** ML / RAG / eval-curious.
- **Core:** auto-generating a gold QA set, pgvector cosine retrieval, the
  LLM-as-judge rubric (relevance / faithfulness / context precision / recall) at
  temp 0, the computed IR metrics (P@k, recall@k, MRR, nDCG@k, F2), and the
  notional-embedding + real-Groq cost model. A worked end-to-end example.
- **Assets:** the retriever SQL; the judge prompt; the metric formulas; one
  worked QA → retrieval → score trace.
- **Source:** `docs/EVALUATION.md`, `docs/retrieval_and_evaluation.html`,
  `backend/app/knowledge/04_*` + `05_*`, `app/services/eval/*`.

### 3. Parallelizing a RAG eval pipeline — and the 4 bugs that taught me how *(war story)*
- **Angle:** engineering war story. Highest engagement; be honest about failures.
- **Audience:** backend / async-Python / infra.
- **Core:** going from a fully sequential pipeline to a parallel one, and what
  broke: (1) a worker **OOM** from batching every file's vectors at once; (2) a
  **deadlock** calling one shared ONNX embedding session from multiple threads;
  (3) **free-tier 429 thrash** from bursting LLM-judge calls, with escalating
  back-off that was *slower* than gentle concurrency; (4) a **zombie run** —
  arq auto-retried an OOM-killed job and crashed on a duplicate-key insert
  because the pipeline wasn't idempotent. The fixes: serialize embedding under a
  lock + stream per file, bound LLM concurrency with a shared semaphore, parse +
  QA-gen + judge concurrently, `max_tries=1` + self-heal orphaned runs on
  startup.
- **Assets:** before/after pipeline diagram; the OOM `exit 137`; the
  `embed_lock`; the semaphore; the self-heal snippet. *(Bonus: the timezone bug
  where naive-UTC timestamps made elapsed time read "+2h".)*
- **Source:** git history (`d316ef6`, `ef31f50`), `app/workers/run_pipeline.py`,
  `app/workers/settings.py`, `backend/app/knowledge/01_*`.

### 4. The stack: FastAPI + arq + pgvector + Next.js *(architecture)*
- **Angle:** system design / decisions.
- **Audience:** full-stack.
- **Core:** sync API vs. async worker boundary, the two Postgres schemas
  (`core` / `results`), `vector(384)` + HNSW cosine, SSE live progress backed by
  Redis pub/sub + a snapshot hash, and the ADRs (why pgvector, why arq, why
  bge-small, why Groq, why a notional cost). Trade-offs, not a feature list.
- **Assets:** the architecture diagram; the ER sketch; the SSE event flow.
- **Source:** `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/DATA_MODEL.md`,
  `docs/implementation.html`.

### 5. Dogfooding RAG: the product is its own docs assistant *(meta)*
- **Angle:** the clever twist. Short and shareable.
- **Audience:** RAG builders.
- **Core:** the "About / Ask the docs" assistant runs the *same* pipeline over
  ChunkLab's own knowledge base (`backend/app/knowledge/*.md` → chunk → embed →
  `results.doc_chunks` → cosine top-k → grounded answer), with idempotent
  re-ingestion via a corpus hash. The tool eats its own dog food.
- **Assets:** the assistant answering a question with citations; the ingest flow.
- **Source:** `backend/app/knowledge/06_*`, `app/services/docs/knowledge.py`.

### 6. *(Optional)* What the numbers actually said *(results)*
- A data post once there are runs worth showing: which strategies won on
  accuracy, which on cost, where the Pareto frontier sat, and the surprises.
- **Source:** real run exports (the CSV download), the analytics dashboard.

---

## Per-post workflow
1. Copy `_TEMPLATE.md` → `blog/NN-slug.md`.
2. Fill the front-matter + outline; pull real snippets/screens from the repo.
3. Draft → tighten to the "one idea per post" rule → add the CTA.
4. Move `status` to `ready`, publish, then backfill the canonical URL.

## Conventions
- **Voice:** first-person, honest, show the failures (especially in #3). No hype.
- **Length:** ~1,200–2,000 words. One idea per post; link siblings instead of
  cramming.
- **Code:** real snippets from the repo (cite `path:line`), not pseudo-code.
- **Screens:** use the new themed UI (Inter + colored charts).
- **Every post ends** with: what it is, the repo link, and an invite to try it.
- **Secrets:** never paste a real key or `.env`; use the placeholders from
  `.env.example`. Screenshots must not show keys.

## Publishing
- **Primary:** dev.to (devs) and/or a personal blog; **cross-post** to Medium and
  Hashnode with `canonical_url` set to the primary.
- **Amplify:** LinkedIn + X/Twitter threads per post; a Show HN for #1 or #3
  once the repo is public.
- **Cadence:** one post / 1–2 weeks, in the order above.
- **Tags:** `rag`, `llm`, `python`, `nextjs`, `postgres`, `pgvector`,
  `webdev`, `opensource`.
