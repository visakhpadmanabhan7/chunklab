# API reference

Concise reference for the chunklab HTTP API. For conceptual background see
`00_what_is_chunklab.md`, `02_data_model.md`, and `06_chat_and_product_assistant.md`.

## Conventions

- **Base URL**: `http://localhost:8000` (backend port 8000).
- **API prefix**: every resource endpoint is mounted under `/api/v1`
  (e.g. `POST /api/v1/projects`). The single exception is `GET /health`, which
  lives at the root. Paths below are shown without the prefix except where noted.
- **Health probe**: `GET /health` returns `{ "status": "ok" }` (used by the
  Docker healthcheck; not rate-limited or logged).
- **Content type**: request/response bodies are JSON unless noted. File upload
  is `multipart/form-data`; chat and progress-stream are streaming responses.
- **IDs**: all resource identifiers are UUIDs.
- **Errors**: FastAPI default shape `{ "detail": "..." }`. Common codes:
  `200` ok, `201` created, `204` deleted (empty body), `400` bad request,
  `404` not found, `422` body failed validation, `429` rate-limit exceeded.
- **Rate limits** (slowapi, keyed by client IP, counters in Redis): global
  default **600/min**; uploads **120/min**; run create + rerun **30/min**; chat
  **30/min**. Exceeding a limit returns **HTTP 429**.

## Projects

A project is the top-level container for files and runs. `ProjectOut` includes
`id, name, description, created_at, updated_at, file_count, run_count`.

- `POST /projects` — create a project. Body: `{ name, description? }`. → `201` `ProjectOut`.
- `GET /projects` — list all projects, newest first (with counts). → array of `ProjectOut`.
- `GET /projects/{project_id}` — fetch one project. → `ProjectOut` / `404`.
- `PATCH /projects/{project_id}` — partial update; only `name` / `description` present in the body are applied. → `ProjectOut` / `404`.
- `DELETE /projects/{project_id}` — delete a project. → `204` / `404`.

## Files

Files belong to a project. Upload saves bytes to storage and enqueues a
background `parse_file_task`. `FileOut` includes
`id, project_id, filename, mime_type, size_bytes, status, parser_used, error, created_at`.

- `POST /projects/{project_id}/files` — **upload a file**. `multipart/form-data` with the file under form field **`upload`**; optional form fields `parser` (default `docling`), `ocr` (bool), `tables` (bool). → `201` `FileOut` (starts `status: "uploaded"`; parsing updates it later). Rate limit **120/min**. `404` if project missing.
- `GET /projects/{project_id}/files` — list files in a project, newest first. → array of `FileOut`.
- `GET /files/{file_id}` — fetch one file's metadata. → `FileOut` / `404`.
- `GET /files/{file_id}/parsed` — fetch the parsed-text artifact (`ParsedDocumentOut`: `file_id, clean_text, char_count, page_count`). Returns `404` ("File not parsed yet") until background parsing completes.
- `DELETE /files/{file_id}` — delete a file and best-effort remove its bytes. → `204` / `404`.

Upload example:

```bash
curl -X POST http://localhost:8000/api/v1/projects/{project_id}/files \
  -F "upload=@document.pdf"
```

## Runs

A run expands chunking-strategy specs into labeled **combinations** and evaluates
each over the selected files; creating a run enqueues `run_pipeline`. `RunOut`
includes `id, project_id, name, status, progress, total_combinations,
embedding_model, top_k, created_at, started_at, completed_at, error`. Status
lifecycle: `queued → running → completed | failed | canceled`.

- `POST /projects/{project_id}/runs` — create and enqueue a run. → `201` `RunOut`. Rate limit **30/min**. Body (`RunCreate`):

  | Field | Type | Notes |
  | --- | --- | --- |
  | `name` | string | required |
  | `combinations` | array of `{ strategy, params }` | required; `params.sizes: [...]` fans one spec into several |
  | `top_k` | int? | falls back to the `TOP_K` setting |
  | `file_ids` | `"all"` \| `[UUID]` | defaults to `"all"` |
  | `qa_per_file` | int? | questions generated per document |
  | `max_qa` | int? | cap on total questions for the run |
  | `enable_judge` | bool | default `true`; `false` = computed IR metrics only |
  | `qa_source` | `"auto"` \| `"mine"` \| `"both"` | default `"auto"` |
  | `provider` / `model` / `api_key` | string? | BYO LLM; key used transiently, never stored |

  Errors: `400` "No valid combinations" (expansion empty) or the missing param
  key; `404` "Project not found".

- `GET /projects/{project_id}/runs` — list runs in a project, newest first. → array of `RunOut`.
- `GET /runs/{run_id}` — fetch one run with its expanded combinations. → `RunDetail` (= `RunOut` + `combinations[]` of `CombinationOut`: `id, run_id, strategy, params, label, status, progress`) / `404`.
- `GET /runs/{run_id}/combinations` — list a run's combinations, ordered by label. → array of `CombinationOut`.
- `POST /runs/{run_id}/cancel` — request cancellation; if `queued`/`running`, status is set to `canceled`, else returned unchanged. → `RunOut` / `404`.
- `POST /runs/{run_id}/rerun` — re-enqueue a new run from the original's stored config (BYO keys are not re-used, so it runs with the server default key). → `201` `RunOut`. Rate limit **30/min**. `400` if the original has no combinations; `404` if not found.
- `DELETE /runs/{run_id}` — delete a run (cascades combinations and all `results.*` rows). → `204` / `404`.

## Progress

Live and snapshot progress for a run. The worker publishes events to a Redis
pub/sub channel (`run:{id}:progress`) and a snapshot hash (`run:{id}:state`).

- `GET /runs/{run_id}/progress` — point-in-time snapshot. → `{ run_id, status, progress, events: [...] }` / `404`. Each event has a discriminating `type` of `run` | `combo` | `file` | `log`.

- `GET /runs/{run_id}/progress/stream` — **Server-Sent Events (SSE)** stream, consumed on the frontend with the native `EventSource`. Behavior: (1) on connect, replays every event in the state hash so a late joiner sees full state; (2) subscribes to the pub/sub channel and forwards new events; (3) emits `event: ping` with `data: {}` when idle (~1s) as keep-alive; (4) closes when a `run` event arrives with a terminal status (`completed` / `failed` / `canceled`) or the client disconnects.

  Each message's `data:` field is a JSON object. Common fields: `type`, `key`
  (stable de-dup key), `status`, `pct` (float `0..1`); plus `comboId` / `label`
  (combo), `fileId` / `stage` (file), `level` / `message` (log). Example frames:

  ```text
  data: {"type":"run","key":"run","status":"running","pct":0.42}

  data: {"type":"combo","key":"combo:d1d1...","comboId":"d1d1...","label":"sentence·256/32","status":"chunking","pct":0.5}

  event: ping
  data: {}

  data: {"type":"run","key":"run","status":"completed","pct":1.0}
  ```

## Results

Per-combination evaluation output, chunk inspection, and the run's shared QA set.
Reports are assembled by `build_run_report()` (joins combinations + metrics +
stats). See `04_qa_generation_and_evaluation.md` for metric definitions.

- `GET /runs/{run_id}/results` — full per-combination report. → `{ run_id, name, status, top_k, combinations: [...] }` / `404`. Each combination carries token/cost/latency fields (`chunk_count, total_tokens, avg_tokens_per_chunk, embedding_cost_usd, judge_cost_usd, total_cost_usd, *_latency_ms`) and accuracy fields (`relevance, faithfulness, context_precision, context_recall, precision_at_k, recall_at_k, mrr, ndcg_at_k, f2, avg_retrieval_latency_ms`). Missing stats/metrics return zeros.
- `GET /combinations/{combination_id}/chunks` — paginated chunk listing for a combination (embedding vectors are **not** returned), ordered by `(file_id, chunk_index)`. Query params: `limit` (default 50, capped at 200), `offset` (default 0). → array of `{ id, file_id, chunk_index, content, token_count, char_count }`.
- `GET /runs/{run_id}/per-question` — disaggregated results, one row per (combination × question): `{ label, strategy, question, precision_at_k, recall_at_k, mrr, ndcg_at_k, f2, relevance, faithfulness, context_precision, context_recall }`.
- `GET /runs/{run_id}/qa-pairs` — the shared QA set generated for the run (one set per run, reused across combinations). → array of `{ id, file_id, question, reference_answer }`.

## Analytics

Comparison and trade-off views over a run, plus a cross-run project summary.
All build on `build_run_report()`.

- `GET /runs/{run_id}/analytics/compare` — the per-combination report scoped to comparison. → `{ run_id, combinations: [...] }` / `404`.
- `GET /runs/{run_id}/analytics/tradeoff` — cost-vs-accuracy scatter points for plotting. → `{ run_id, points: [...] }`. Each point: `label, strategy, cost` (=`total_cost_usd`), `accuracy` (=`ndcg_at_k`), `latency_ms` (=`avg_retrieval_latency_ms`), `tokens` (=`total_tokens`). `404` if run missing.
- `GET /projects/{project_id}/analytics/runs` — cross-run summary, one row per run with its best combination (by nDCG@k) and roll-up totals. → `{ project_id, runs: [{ run_id, name, status, combinations, best_label, best_ndcg, total_cost_usd, total_tokens }] }`. `best_label` / `best_ndcg` are `null` / `0.0` when a run has no reportable combinations.

## Chat

A single streaming endpoint serving both the analyst assistant and the product
assistant (selected by `scope`). See `06_chat_and_product_assistant.md`.

- `POST /chat/stream` — answer a natural-language question. Rate limit **30/min**. Response is **`Content-Type: text/plain; charset=utf-8`**, a token stream (chunked transfer / `ReadableStream`) — **NOT** SSE; the frontend reads it with `fetch` + `ReadableStream`. There is no JSON envelope; provider/key errors are surfaced inline in the stream.

  Body (`ChatRequest`):

  | Field | Type | Notes |
  | --- | --- | --- |
  | `scope` | `project` \| `run` \| `compare` \| `about` | selects the context source |
  | `project_id` | UUID? | required when `scope = project` |
  | `run_id` | UUID? | required when `scope = run` |
  | `run_ids` | `[UUID]`? | required when `scope = compare` (at least **two** ids) |
  | `message` | string | the user's question (required) |
  | `history` | `[{ role, content }]` | prior turns; default `[]` |
  | `provider` / `model` / `api_key` | string? | optional bring-your-own LLM, used transiently, never stored |

  The `about` scope is the **product assistant** on the About page: it answers
  questions about chunklab itself by RAG-retrieving over the `app/knowledge/*.md`
  docs and needs no `project_id` / `run_id`.

  Validation errors (`400`): `scope=run` without `run_id`; `scope=compare`
  without two `run_ids`; `scope=project` without `project_id`. A malformed body
  (invalid `scope`, missing `message`) returns `422`.

## QA sets

A project-level, user-curated QA set (`ProjectQAPair`), separate from the
auto-generated per-run QA pairs under [Results](#results). Runs can use these via
`qa_source = "mine"` or `"both"`.

- `GET /projects/{project_id}/qa-set` — list the project's curated QA items, oldest first. → array of `{ id, question, reference_answer, source_file?, source_chunk_text? }`.
- `POST /projects/{project_id}/qa-set` — add one or more QA items. Body: array of `{ question, reference_answer, source_file?, source_chunk_text? }`; blank items are skipped. → `201` array of created items / `404` if project missing.
- `DELETE /qa-set/{item_id}` — delete a single QA item. → `204` (no error if the id does not exist).

## Logs

Client-side log ingest so UI actions/errors land in the backend log stream
(visible in `docker compose logs backend`).

- `POST /logs` — ingest a batch of client events. Body: `{ events: [{ level?, event, detail?, path? }] }` (`level` one of `debug` | `info` | `warn` | `error`, default `info`). → `{ ok: true, received: <n> }`.
