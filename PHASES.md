# chunklab — Phases & Improvements

A living roadmap. **Shipped** = built & verified. **Proposed** = discussed, not yet
built (with effort + trade-offs). **Backlog** = ideas worth doing later.
Updated as we discuss more.

---

## ✅ Phase 1 — Core product (shipped)
- Projects, files, runs; FastAPI + arq worker; Postgres + **pgvector**; Next.js 15 UI.
- Two DB schemas: `core` (app data) + `results` (experiment output, incl. `vector(384)` + HNSW).
- 5 chunking strategies (sentence / character / recursive / token / semantic) + combinatorial run builder.
- Embeddings: FastEmbed **bge-small** (384-d) + HF tokenizer for token counts.
- Eval: Groq auto-generated QA set → retrieve top-k → **LLM-as-judge** + computed IR (P@k, recall, MRR, nDCG, F2).
- Token + cost tracking (notional embed rate + real Groq judge cost).
- RAG chatbot (project / run / compare scopes), streaming.
- Docker Compose (postgres/pgvector, redis, backend, worker, frontend); full docs + `docs/overview.html`.

## ✅ Phase 2 — Hardening & UX (shipped)
- **docling fixed** (torch/torchvision CPU pin + transformers <5) and made configurable: parser = Docling (rich) / Fast (text); **OCR** + **table-extraction** toggles per upload.
- docling **converter cached** (models load once) + serialized with a lock.
- **Uploads discarded after parse** — only extracted text is retained.
- **Multi-file upload** with per-file **progress bars** (XHR).
- **Granular run progress** (combo bars advance through chunk→embed→eval, not 0→50→100).
- **Select + bulk delete** on Files and Runs; per-run delete (`DELETE /runs/{id}`).
- **QA set tab** on the run page — inspect the generated questions/answers.
- **Rate limiting** (slowapi): 600/min global, 30/min chat, 30/min runs, 120/min uploads → `429`.
- **Multi-level logging**: request middleware (info/warn/error by status) + UI action logger → `/api/v1/logs`.
- **Worker self-heal**: re-enqueues files stuck in `uploaded`/`parsing` on restart.
- `init: true` on backend/worker (no zombie-container hangs).
- **About page** (`/about`) with in-app docs; clearer tagline; "Run not found" handling.
- **Free-tier resilience**: Groq **429 retry/backoff** (`max_retries`), **capped eval set** (`MAX_QA_PAIRS_PER_RUN=10`), and `GROQ_MODEL` swappable (e.g. `llama-3.1-8b-instant`) to dodge a per-model daily cap.
- **Fixed `GET /runs/{id}` 500** (async lazy-load of the `combinations` relationship during Pydantic validation).
- `sample_docs/` with standard benchmarks (Attention paper PDF, Paul Graham essay, State of the Union, Wikipedia) + synthetic structure samples.

---

## 🔭 Phase 3 — Performance & scale (proposed)

### 3.1 Parallelize the workers  *(discussed)*
Current: `arq max_jobs=4` (4 concurrent jobs in **one** process); docling serialized by a lock; a run is a **single** job processing combinations sequentially.

| Option | Effect | Trade-off | Status |
|---|---|---|---|
| **Scale worker processes** — `docker compose up --scale worker=N` | True multi-core parallelism (separate processes, bypasses GIL; each has its own docling lock) | N× RAM (~0.5–1 GB/process for models); keep N ≤ CPU cores | **recommended next** |
| **Bump `max_jobs`** | More concurrent jobs/process | Helps I/O-bound only; CPU-bound parsing/embedding still contend; docling lock still serializes | low value alone |
| **Loosen docling lock** | Parallel docling conversions | Race risk + CPU thrash on one box; only with more cores/processes | risky |
| **Fan out `run_pipeline` into per-combination jobs** | Multi-combo runs run ~Nx faster across workers | QA-gen must finish first; cross-job progress aggregation + completion detection; more DB contention | **biggest win, more work** |

**Recommendation:** scale worker processes first (low risk), then fan out the run pipeline per-combination. Ceiling is CPU cores + RAM (parsing/embedding are CPU-bound) — GPU or a bigger box beyond that.

> ⚠️ **The real bottleneck for a run is the LLM rate limit, not the worker.** A run
> splits into (a) chunk + embed — local CPU, already fast — and (b) QA-gen + judge —
> **Groq API**, throttled by the account's tokens-per-minute. Parallelizing
> combinations makes them all hit the **same shared Groq quota** at once → more
> `429`/retries, ~no net speedup on the free tier. So parallelization is the
> **second** lever; the **first** is LLM throughput. Order of impact:
> 1. Fewer LLM calls (fewer combos, lower top-k, fewer QA pairs — already capped at 10).
> 2. Faster pass: skip the LLM judge and report only computed IR metrics (no API, instant).
> 3. Higher Groq tier (bigger TPM) **or** Phase 5 (multiple keys/providers to spread judge calls).
> 4. **Then** parallelize (3.1) for a genuine N× — once the LLM is no longer the ceiling.

### 3.2 Other perf
- GPU acceleration for docling layout + FastEmbed (big speedup for PDFs/embedding).
- Cache embeddings across runs for identical (text, model) to avoid re-embedding.
- Stream/iterative embedding for very large files to cap memory.

---

## 🔭 Phase 4 — Robustness & multi-instance (proposed)
- **Redis-backed rate limiter** (`slowapi storage_uri`) so limits are global across scaled backends.
- **Alembic migrations** instead of startup `create_all` (safe schema evolution; today a reset is needed for new columns).
- **Cancel that actually stops work** — the worker should check a cancel flag mid-run (today cancel only marks status).
- **Re-parse / re-run endpoints** (re-process a file or re-run a config without re-upload).
- **Persisted structured logs** (DB table / log shipper) instead of stdout-only, for querying UI events.
- **GitHub secret scanning + push protection** (needs a plan that supports it on private repos).

## 🔭 Phase 5 — Bring-your-own-key & multi-provider (proposed)

**Goal:** let users run the whole tool with **their own keys and chosen providers**
(Groq / OpenAI / Anthropic / …), and pick a provider + model **per role** — judge,
chat, QA-generation, (and eventually embeddings) — selected when launching an
experiment or starting a chat. The codebase adapts to call whatever is configured.

### Scope
- **Key entry UI** — a Settings/keys screen to enter & manage keys per provider
  (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`). Show which providers
  are "ready". Keys are write-only in the UI (masked, never echoed back).
- **Per-role provider+model selection**:
  - **Run create** → choose provider+model for **QA generation** and the **judge**.
  - **Chat** → choose provider+model at chat time.
  - Sensible defaults from server env so it works with zero config.
- **Codebase adaptation** — generalize `app/core/llm.py` into a **provider registry**:
  `get_llm(provider, model, api_key)` with adapters for Groq (have), OpenAI,
  Anthropic. Persist the chosen provider/model on `runs.config` and pass to the
  worker; `ChatRequest` carries provider/model.

### Key handling (decision needed — security-sensitive)
| Approach | Pros | Cons |
|---|---|---|
| **Server env defaults only** (today) | simplest, key never leaves server | not user-selectable |
| **Session-only** (entered in UI, sent per request, never stored) | most secure; no at-rest secret | re-enter each session |
| **Stored encrypted server-side** (a `credentials` table, encrypted at rest, per user/project) | convenient, persists | needs encryption + key management + careful redaction |
- **Non-negotiables:** never log keys (scrub from access/UI/app logs), transmit only over the API, mask in responses. Recommend **session-only or encrypted-at-rest**, not plaintext DB.

### Hard part: pluggable **embeddings**
- The judge/chat/QA roles are text-LLM swaps → straightforward.
- Swapping the **embedding** model changes the **vector dimension**, but the pgvector
  column is a fixed `vector(384)`. BYO embeddings therefore needs either: a dim stored
  per run with per-dimension columns/tables, or one fixed dim per project. Treat
  embedding-provider choice as a **later sub-phase** after text-LLM BYO ships.

### Also needed
- **Per-provider/model pricing** in `core/pricing.py` (today Groq-only) so cost stays accurate across providers.
- Graceful errors for missing/invalid keys (clear 4xx + UI message, no crash).
- Dependencies: `openai`, `anthropic` SDKs (Groq already present).

**Effort:** medium for text-LLM BYO (judge/chat/QA + key entry); larger if embeddings included. **Recommended order:** provider registry → per-role select for judge/chat/QA → key entry (session-first) → pricing table → (later) pluggable embeddings.

---

## 🔭 Phase 6 — User-provided QA / ground-truth (proposed)

**Today** the QA evaluation set is auto-generated by Groq from each document. Let
users **bring their own** questions + reference answers so runs are scored against
trusted, domain-specific ground truth instead of (or alongside) generated ones.

**Scope:**
- **Import/paste/edit a QA set per project** — CSV/JSON of `question, reference_answer`
  (+ optional `source_file` and gold-span/`source_chunk_text` for computed metrics).
- **Run option**: choose the eval source — *auto-generate*, *use my QA set*, or *both*.
- Turn the **QA-set tab into a full editor** (add / edit / delete), not just a viewer.

**Benefits:** more trustworthy + reproducible metrics; **no LLM tokens spent on QA
generation** (helps the free-tier rate limit); stable eval sets across runs.

**Effort:** medium — CRUD endpoints over the existing `results.qa_pairs` table (plus
a way to store project-level reusable sets), an import/edit UI, and a run flag to pick
the source. The computed IR metrics already rely on a gold passage, so user rows
should include one (or fall back to LLM-judge-only when absent).

---

## 🔭 Phase 7 — Selectable metrics + per-question (disaggregated) results (proposed)

**Today** the results tab shows a fixed set of all 9 metrics, **aggregated** (macro-averaged) to one
row per combination. Let users **pick which metrics** they care about and view/export results in
**both shapes**: aggregated (per combination) *and* separate/per-question (one row per combination ×
question), choosing whichever they want.

**What already exists (most of the data is there):**
- ✅ **Aggregated** per-combination metrics — the `results.metrics` row (drives the dashboard today).
- ✅ **Per-question judge** scores — already stored in `results.judge_evaluations` (one per retrieval), just not surfaced.
- ✅ **Per-question retrievals** (which chunks + cosine scores) — already stored in `results.retrievals`.

**What to add:**
- **Persist per-question *computed* metrics** — the only real gap: `compute_for_query` results are
  currently averaged away. Add a `results.query_metrics` table (or JSON column on `retrievals`) so the
  per-question view has P@k/recall/MRR/nDCG/F2 too, not just the judge dims. *(Small `run_pipeline` change.)*
- **Per-question results endpoint** — `GET /runs/{id}/per-question` returning, per combination × question:
  retrieved chunks, computed metrics, and judge scores (reuse `reporting.py` join patterns).
- **UI: an "Aggregated | Per-question" toggle** on the results tab, plus a **metric multi-select**
  (checkboxes) that drives the table, charts, and CSV — so the user shows exactly the metrics they want.
- **CSV export in both shapes** (one row per combination, or per combination × question), limited to the
  selected metrics.

**Benefits:** drill into *why* a combination scored as it did (which questions it failed), spot
question-level variance the macro-average hides, and export tailored metric sets for offline analysis.

**Effort:** small–medium. The judge per-question data is already captured; the main backend work is
persisting per-question computed metrics + the new endpoint. The rest is a UI toggle, a metric selector,
and CSV shaping.

---

## 💡 Backlog / future ideas
- **Run-progress UI redesign** (held — awaiting user go-ahead): the live progress screen (overall bar + per-combination rows + activity feed) looks basic; design a cleaner layout — e.g. per-stage chips (chunk→embed→retrieve→judge), per-file detail, nicer empty/queued/running states, and a clearer "throttled / retrying" indicator when Groq is rate-limiting. Not started.
- **Auth & multi-user** (today everything is `user_id="anonymous"`).
- **More strategies**: markdown-aware, sliding-window, proposition-based, late chunking.
- **Re-ranking** step (cross-encoder) before judging; configurable retrievers.
- **Pareto view** + statistical significance across runs in analytics.
- **Export/share** a run report (PDF/HTML); CSV already available.
- **Generated client types** via `openapi-typescript` from the FastAPI schema.
- **Expanded tests + CI** (integration tests against a pgvector test container).
