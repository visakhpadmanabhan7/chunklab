# chunklab REST API Reference

Complete reference for the chunklab HTTP API.

- **Base URL**: `http://localhost:8000`
- **API prefix**: all resource endpoints are mounted under `/api/v1` (e.g. `POST /api/v1/projects`). The `/health` endpoint is the only exception — it lives at the root.
- **Content type**: request/response bodies are JSON (`application/json`) unless noted. File upload uses `multipart/form-data`. The chat and progress-stream endpoints return streaming responses.
- **IDs**: all resource identifiers are UUIDs.
- **CORS**: allowed origins come from the `CORS_ORIGINS` setting (default `http://localhost:3000`).

## Conventions

### Error responses

Errors use FastAPI's default shape:

```json
{ "detail": "Project not found" }
```

Common status codes used across the API:

| Status | Meaning |
| --- | --- |
| `200 OK` | Successful read or action |
| `201 Created` | Resource created |
| `204 No Content` | Successful delete (empty body) |
| `400 Bad Request` | Invalid combinations / missing required scope fields |
| `404 Not Found` | Resource does not exist |
| `422 Unprocessable Entity` | Request body failed Pydantic validation |

### Resource groups

| Group | Prefix |
| --- | --- |
| [Health](#health) | `/health` |
| [Projects](#projects) | `/api/v1/projects` |
| [Files](#files) | `/api/v1/...` |
| [Runs](#runs) | `/api/v1/...` |
| [Progress](#progress) | `/api/v1/runs/{run_id}/progress` |
| [Results](#results) | `/api/v1/...` |
| [Analytics](#analytics) | `/api/v1/...` |
| [Chat](#chat) | `/api/v1/chat` |

---

## Health

### `GET /health`

Liveness probe (not under `/api/v1`). Used by the Docker healthcheck.

**Response `200 OK`**

```json
{ "status": "ok" }
```

---

## Projects

A project is the top-level container for uploaded files and evaluation runs.

### `POST /api/v1/projects`

Create a project.

**Request body**

```json
{
  "name": "My corpus",
  "description": "Optional free text"
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes | |
| `description` | string \| null | no | |

**Response `201 Created`** — `ProjectOut`

```json
{
  "id": "8f1d2c3a-0000-0000-0000-000000000001",
  "name": "My corpus",
  "description": "Optional free text",
  "created_at": "2026-06-13T10:00:00Z",
  "updated_at": "2026-06-13T10:00:00Z",
  "file_count": 0,
  "run_count": 0
}
```

### `GET /api/v1/projects`

List all projects, newest first. `file_count` and `run_count` are populated from aggregate queries.

**Response `200 OK`** — array of `ProjectOut`

```json
[
  {
    "id": "8f1d2c3a-0000-0000-0000-000000000001",
    "name": "My corpus",
    "description": "Optional free text",
    "created_at": "2026-06-13T10:00:00Z",
    "updated_at": "2026-06-13T10:00:00Z",
    "file_count": 3,
    "run_count": 2
  }
]
```

### `GET /api/v1/projects/{project_id}`

Fetch a single project (with counts).

**Response `200 OK`** — `ProjectOut` (see above).
**Response `404`** — `{ "detail": "Project not found" }`.

### `PATCH /api/v1/projects/{project_id}`

Partially update a project. Only fields present in the body are applied.

**Request body**

```json
{
  "name": "Renamed corpus",
  "description": "Updated description"
}
```

Both fields are optional; either or both may be supplied.

**Response `200 OK`** — `ProjectOut`.
**Response `404`** — `{ "detail": "Project not found" }`.

### `DELETE /api/v1/projects/{project_id}`

Delete a project.

**Response `204 No Content`** — empty body.
**Response `404`** — `{ "detail": "Project not found" }`.

---

## Files

Files belong to a project. On upload the file is saved to `STORAGE_DIR/{project_id}/` and a `parse_file_task` is enqueued on the arq/Redis queue for background parsing (docling primary, pypdf/text fallback).

### `POST /api/v1/projects/{project_id}/files`

Upload a file. **`multipart/form-data`** with the file under form field name **`upload`**.

```bash
curl -X POST http://localhost:8000/api/v1/projects/{project_id}/files \
  -F "upload=@document.pdf"
```

**Response `201 Created`** — `FileOut`. The file starts in `status: "uploaded"`; parsing runs asynchronously and updates `status` / `parser_used` afterward.

```json
{
  "id": "a1b2c3d4-0000-0000-0000-000000000010",
  "project_id": "8f1d2c3a-0000-0000-0000-000000000001",
  "filename": "document.pdf",
  "mime_type": "application/pdf",
  "size_bytes": 524288,
  "status": "uploaded",
  "parser_used": null,
  "error": null,
  "created_at": "2026-06-13T10:05:00Z"
}
```

**Response `404`** — `{ "detail": "Project not found" }`.

### `GET /api/v1/projects/{project_id}/files`

List files in a project, newest first.

**Response `200 OK`** — array of `FileOut`.

### `GET /api/v1/files/{file_id}`

Fetch a single file's metadata.

**Response `200 OK`** — `FileOut`.
**Response `404`** — `{ "detail": "File not found" }`.

### `GET /api/v1/files/{file_id}/parsed`

Fetch the parsed-text artifact for a file. Returns `404` until background parsing completes.

**Response `200 OK`** — `ParsedDocumentOut`

```json
{
  "file_id": "a1b2c3d4-0000-0000-0000-000000000010",
  "clean_text": "Full extracted document text ...",
  "char_count": 18432,
  "page_count": 12
}
```

**Response `404`** — `{ "detail": "File not parsed yet" }`.

### `DELETE /api/v1/files/{file_id}`

Delete a file and remove its bytes from storage (best-effort unlink).

**Response `204 No Content`** — empty body.
**Response `404`** — `{ "detail": "File not found" }`.

---

## Runs

A run expands a set of chunking-strategy specifications into one or more labeled **combinations**, then evaluates each combination over the selected files. Creating a run enqueues `run_pipeline` on the worker.

### `POST /api/v1/projects/{project_id}/runs`

Create and enqueue a run.

**Request body** — `RunCreate`

```json
{
  "name": "Sweep v1",
  "top_k": 5,
  "combinations": [
    { "strategy": "sentence",  "params": { "sizes": [256, 512], "overlap": 32 } },
    { "strategy": "character", "params": { "size": 1000, "overlap": 100 } },
    { "strategy": "recursive", "params": { "chunk_size": 800, "overlap": 80 } },
    { "strategy": "token",     "params": { "size": 384, "overlap": 48 } },
    { "strategy": "semantic",  "params": { "breakpoint_percentile": 90 } }
  ],
  "file_ids": "all"
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes | Human-readable run name. |
| `top_k` | int \| null | no | Retrieval depth. Falls back to the `TOP_K` setting (default `5`) when null/omitted. |
| `combinations` | array of `CombinationSpec` | yes | Each item is `{ "strategy": string, "params": object }`. |
| `file_ids` | `"all"` \| array of UUID | no | Which files to evaluate. Defaults to `"all"`. |

**`CombinationSpec`** shape:

```json
{ "strategy": "sentence", "params": { "size": 512, "overlap": 32 } }
```

`params` may include a `sizes: [...]` array (instead of a single `size`) to fan out one spec into several combinations. The expander (`expand()`) turns specs into labeled, de-duplicated combination cells; label formats per strategy:

| Strategy | Params | Label format |
| --- | --- | --- |
| `sentence` | `size` (tokens), `overlap` | `sentence·{size}/{overlap}` |
| `character` | `size` (chars), `overlap` | `character·{size}/{overlap}` |
| `recursive` | `chunk_size`, `overlap` | `recursive·{chunk_size}/{overlap}` |
| `token` | `size` (tokens), `overlap` | `token·{size}/{overlap}` |
| `semantic` | `breakpoint_percentile` | `semantic·pct{n}` |

**Response `201 Created`** — `RunOut`

```json
{
  "id": "c0ffee00-0000-0000-0000-000000000100",
  "project_id": "8f1d2c3a-0000-0000-0000-000000000001",
  "name": "Sweep v1",
  "status": "queued",
  "progress": 0.0,
  "total_combinations": 6,
  "embedding_model": "BAAI/bge-small-en-v1.5",
  "top_k": 5,
  "created_at": "2026-06-13T10:10:00Z",
  "started_at": null,
  "completed_at": null,
  "error": null
}
```

**Error responses**

- `400` — `{ "detail": "No valid combinations" }` when expansion yields nothing.
- `400` — `{ "detail": "<missing param key>" }` when a spec omits a required param.
- `404` — `{ "detail": "Project not found" }`.

**Run `status` lifecycle**: `queued` → `running` → `completed` | `failed` | `canceled`.

### `GET /api/v1/projects/{project_id}/runs`

List runs in a project, newest first.

**Response `200 OK`** — array of `RunOut`.

### `GET /api/v1/runs/{run_id}`

Fetch a single run with its expanded combinations.

**Response `200 OK`** — `RunDetail` (= `RunOut` plus a `combinations` array of `CombinationOut`)

```json
{
  "id": "c0ffee00-0000-0000-0000-000000000100",
  "project_id": "8f1d2c3a-0000-0000-0000-000000000001",
  "name": "Sweep v1",
  "status": "running",
  "progress": 0.42,
  "total_combinations": 6,
  "embedding_model": "BAAI/bge-small-en-v1.5",
  "top_k": 5,
  "created_at": "2026-06-13T10:10:00Z",
  "started_at": "2026-06-13T10:10:05Z",
  "completed_at": null,
  "error": null,
  "combinations": [
    {
      "id": "d1d1d1d1-0000-0000-0000-000000000200",
      "run_id": "c0ffee00-0000-0000-0000-000000000100",
      "strategy": "sentence",
      "params": { "size": 256, "overlap": 32 },
      "label": "sentence·256/32",
      "status": "completed",
      "progress": 1.0
    }
  ]
}
```

**Response `404`** — `{ "detail": "Run not found" }`.

### `GET /api/v1/runs/{run_id}/combinations`

List the combinations for a run (ordered by label).

**Response `200 OK`** — array of `CombinationOut` (see the `combinations[]` shape above).

### `POST /api/v1/runs/{run_id}/cancel`

Request cancellation. If the run is `queued` or `running`, its status is set to `canceled`; otherwise the run is returned unchanged.

**Response `200 OK`** — `RunOut` (with the updated `status`).
**Response `404`** — `{ "detail": "Run not found" }`.

---

## Progress

Live and snapshot progress for a run. The worker publishes events to a Redis pub/sub channel (`run:{id}:progress`) and maintains a snapshot hash (`run:{id}:state`); these endpoints expose both.

### `GET /api/v1/runs/{run_id}/progress`

Point-in-time snapshot. Returns the run's denormalized status/progress plus the full set of latest events from the state hash.

**Response `200 OK`**

```json
{
  "run_id": "c0ffee00-0000-0000-0000-000000000100",
  "status": "running",
  "progress": 0.42,
  "events": [
    { "type": "run", "key": "run", "status": "running", "pct": 0.42 },
    { "type": "combo", "key": "combo:d1d1...200", "comboId": "d1d1...200",
      "label": "sentence·256/32", "status": "completed", "pct": 1.0 }
  ]
}
```

**Response `404`** — `{ "detail": "Run not found" }`.

### `GET /api/v1/runs/{run_id}/progress/stream`

Server-Sent Events (SSE) stream. Consumed on the frontend with the native `EventSource`.

Behavior:

1. **Replay** — on connect, every event currently in the state hash is emitted (so a late joiner sees full state).
2. **Live** — then the endpoint subscribes to the pub/sub channel and forwards new events as they are published.
3. **Keep-alive** — when there is no message within ~1s, an SSE comment-style `event: ping` with `data: {}` is emitted.
4. **Termination** — the stream closes when a `run` event arrives with a terminal status (`completed`, `failed`, or `canceled`), or when the client disconnects.

Each SSE message's `data:` field is a JSON object with a discriminating `type`. Event shapes:

**`run`** — overall run progress

```json
{ "type": "run", "key": "run", "status": "running", "pct": 0.42 }
```

**`combo`** — per-combination progress

```json
{
  "type": "combo",
  "key": "combo:{comboId}",
  "comboId": "d1d1d1d1-0000-0000-0000-000000000200",
  "label": "sentence·256/32",
  "status": "chunking",
  "pct": 0.5
}
```

**`file`** — per-file stage within a combination

```json
{
  "type": "file",
  "key": "file:{comboId}:{fileId}",
  "comboId": "d1d1d1d1-0000-0000-0000-000000000200",
  "fileId": "a1b2c3d4-0000-0000-0000-000000000010",
  "stage": "embedding",
  "status": "running",
  "pct": 0.75
}
```

**`log`** — human-readable log line

```json
{ "type": "log", "key": "log:7", "level": "info", "message": "Generating QA set" }
```

| Field | Appears in | Notes |
| --- | --- | --- |
| `type` | all | `run` \| `combo` \| `file` \| `log` |
| `key` | all | Stable de-dup key used in the snapshot hash. |
| `status` | run/combo/file | e.g. `queued`, `running`, `chunking`, `evaluating`, `completed`, `failed`, `canceled`. |
| `pct` | run/combo/file | Float in `[0, 1]`, rounded to 4 decimals. |
| `comboId` | combo/file | Combination UUID. |
| `label` | combo | Combination label. |
| `fileId` | file | File UUID. |
| `stage` | file | e.g. `chunking`, `embedding`, `retrieving`, `judging`. |
| `level` | log | `info`, `warning`, `error`, etc. |
| `message` | log | Log text. |

Raw stream excerpt:

```text
data: {"type":"run","key":"run","status":"running","pct":0.42}

data: {"type":"combo","key":"combo:d1d1...","comboId":"d1d1...","label":"sentence·256/32","status":"chunking","pct":0.5}

event: ping
data: {}

data: {"type":"run","key":"run","status":"completed","pct":1.0}
```

---

## Results

Per-combination evaluation output, chunk inspection, and the shared QA set. The combination report is assembled by `build_run_report()` (joining `run_combinations` + `metrics` + `combination_stats`).

### `GET /api/v1/runs/{run_id}/results`

Full per-combination report for a run.

**Response `200 OK`**

```json
{
  "run_id": "c0ffee00-0000-0000-0000-000000000100",
  "name": "Sweep v1",
  "status": "completed",
  "top_k": 5,
  "combinations": [
    {
      "combination_id": "d1d1d1d1-0000-0000-0000-000000000200",
      "label": "sentence·256/32",
      "strategy": "sentence",
      "params": { "size": 256, "overlap": 32 },
      "status": "completed",

      "chunk_count": 142,
      "total_tokens": 36352,
      "avg_tokens_per_chunk": 256.0,
      "embedding_cost_usd": 0.000727,
      "judge_cost_usd": 0.004210,
      "total_cost_usd": 0.004937,
      "chunk_latency_ms": 318,
      "embed_latency_ms": 1204,
      "eval_latency_ms": 8800,

      "relevance": 0.88,
      "faithfulness": 0.91,
      "context_precision": 0.80,
      "context_recall": 0.76,
      "precision_at_k": 0.42,
      "recall_at_k": 0.85,
      "mrr": 0.71,
      "ndcg_at_k": 0.77,
      "f2": 0.68,
      "avg_retrieval_latency_ms": 12.4
    }
  ]
}
```

Notes on the per-combination fields:

- **tokens/cost/latency** (`chunk_count` … `eval_latency_ms`) come from `combination_stats`. `embedding_cost_usd` is notional (local embeddings are free, kept so combinations are dollar-comparable); `judge_cost_usd` is the real Groq cost.
- **accuracy** fields come from `metrics`. `relevance` / `faithfulness` / `context_precision` / `context_recall` are LLM-judge means (0..1). `precision_at_k` / `recall_at_k` / `mrr` / `ndcg_at_k` / `f2` are computed macro-averages against the gold passage.
- Any combination without stats/metrics yet returns zeros for those fields.

**Response `404`** — `{ "detail": "Run not found" }`.

### `GET /api/v1/combinations/{combination_id}/chunks`

Paginated listing of the chunks produced by a combination. Embedding vectors are **not** returned.

**Query parameters**

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `limit` | int | `50` | Capped at `200`. |
| `offset` | int | `0` | |

Ordered by `(file_id, chunk_index)`.

**Response `200 OK`** — array of chunk objects

```json
[
  {
    "id": "e2e2e2e2-0000-0000-0000-000000000300",
    "file_id": "a1b2c3d4-0000-0000-0000-000000000010",
    "chunk_index": 0,
    "content": "First chunk of text ...",
    "token_count": 256,
    "char_count": 1180
  }
]
```

### `GET /api/v1/runs/{run_id}/qa-pairs`

The shared QA set generated for the run (one set per run, reused across all combinations).

**Response `200 OK`** — array of QA pairs

```json
[
  {
    "id": "f3f3f3f3-0000-0000-0000-000000000400",
    "file_id": "a1b2c3d4-0000-0000-0000-000000000010",
    "question": "What is the reported throughput?",
    "reference_answer": "The reported throughput is 1.2 Gbps."
  }
]
```

---

## Analytics

Comparison and trade-off views over a run, plus a cross-run summary for a project. All build on `build_run_report()`.

### `GET /api/v1/runs/{run_id}/analytics/compare`

Same per-combination report as `/results`, scoped to comparison (no run-level metadata wrapper beyond `run_id`).

**Response `200 OK`**

```json
{
  "run_id": "c0ffee00-0000-0000-0000-000000000100",
  "combinations": [ /* per-combination report objects, see /results */ ]
}
```

**Response `404`** — `{ "detail": "Run not found" }`.

### `GET /api/v1/runs/{run_id}/analytics/tradeoff`

Cost-vs-accuracy scatter points, one per combination — convenient for plotting.

**Response `200 OK`**

```json
{
  "run_id": "c0ffee00-0000-0000-0000-000000000100",
  "points": [
    {
      "label": "sentence·256/32",
      "strategy": "sentence",
      "cost": 0.004937,
      "accuracy": 0.77,
      "latency_ms": 12.4,
      "tokens": 36352
    }
  ]
}
```

| Point field | Source |
| --- | --- |
| `cost` | `total_cost_usd` |
| `accuracy` | `ndcg_at_k` |
| `latency_ms` | `avg_retrieval_latency_ms` |
| `tokens` | `total_tokens` |

**Response `404`** — `{ "detail": "Run not found" }`.

### `GET /api/v1/projects/{project_id}/analytics/runs`

Cross-run summary for a project: one row per run with its best combination (by nDCG@k) and roll-up totals.

**Response `200 OK`**

```json
{
  "project_id": "8f1d2c3a-0000-0000-0000-000000000001",
  "runs": [
    {
      "run_id": "c0ffee00-0000-0000-0000-000000000100",
      "name": "Sweep v1",
      "status": "completed",
      "combinations": 6,
      "best_label": "sentence·512/32",
      "best_ndcg": 0.81,
      "total_cost_usd": 0.029104,
      "total_tokens": 210432
    }
  ]
}
```

`best_label` / `best_ndcg` are `null` / `0.0` when a run has no reportable combinations.

---

## Chat

A single streaming endpoint that answers natural-language questions about a project, a single run, or a comparison of two-plus runs. Context is built from the run report and (for `run` scope) retrieved chunks; the model is Groq `llama-3.3-70b-versatile` via the `CHAT_SYSTEM_PROMPT`.

### `POST /api/v1/chat/stream`

**Request body** — `ChatRequest`

```json
{
  "scope": "run",
  "project_id": null,
  "run_id": "c0ffee00-0000-0000-0000-000000000100",
  "run_ids": null,
  "message": "Which combination has the best recall and why?",
  "history": [
    { "role": "user", "content": "Summarize this run." },
    { "role": "assistant", "content": "The run swept 6 combinations ..." }
  ]
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `scope` | `"project"` \| `"run"` \| `"compare"` | yes | Selects the context source. |
| `project_id` | UUID \| null | conditional | Required when `scope = "project"`. |
| `run_id` | UUID \| null | conditional | Required when `scope = "run"`. |
| `run_ids` | array of UUID \| null | conditional | Required when `scope = "compare"` (must contain **at least two** ids). |
| `message` | string | yes | The user's question. |
| `history` | array of `ChatMessage` | no | Prior turns. Each item is `{ "role": "user" \| "assistant", "content": string }`. Defaults to `[]`. |

**Scope examples**

Project scope:

```json
{ "scope": "project", "project_id": "8f1d...0001", "message": "Which run performed best overall?", "history": [] }
```

Compare scope:

```json
{ "scope": "compare", "run_ids": ["c0ffee00-...-0100", "c0ffee00-...-0101"], "message": "Compare these two runs.", "history": [] }
```

**Response `200 OK`** — `Content-Type: text/plain; charset=utf-8`, a **token stream** (chunked transfer / `ReadableStream`). The body is the answer text streamed token-by-token as it is generated; there is no JSON envelope. The frontend consumes it via `fetch` + `ReadableStream`.

```text
The combination with the best recall is sentence·512/32, because larger
sentence windows capture more of the gold passage per chunk, raising
recall@k while keeping precision acceptable ...
```

**Validation errors `400`**

- `scope = "run"` without `run_id` → `{ "detail": "run_id required for scope=run" }`
- `scope = "compare"` without two run ids → `{ "detail": "two run_ids required for scope=compare" }`
- `scope = "project"` without `project_id` → `{ "detail": "project_id required for scope=project" }`

A malformed body (e.g. invalid `scope` value or missing `message`) returns `422`.

---

## Schema reference

### `ProjectOut`

| Field | Type |
| --- | --- |
| `id` | UUID |
| `name` | string |
| `description` | string \| null |
| `created_at` | datetime |
| `updated_at` | datetime |
| `file_count` | int |
| `run_count` | int |

### `FileOut`

| Field | Type |
| --- | --- |
| `id` | UUID |
| `project_id` | UUID |
| `filename` | string |
| `mime_type` | string \| null |
| `size_bytes` | int \| null |
| `status` | string |
| `parser_used` | string \| null |
| `error` | string \| null |
| `created_at` | datetime |

### `ParsedDocumentOut`

| Field | Type |
| --- | --- |
| `file_id` | UUID |
| `clean_text` | string |
| `char_count` | int |
| `page_count` | int \| null |

### `RunOut`

| Field | Type |
| --- | --- |
| `id` | UUID |
| `project_id` | UUID |
| `name` | string |
| `status` | string |
| `progress` | float |
| `total_combinations` | int |
| `embedding_model` | string |
| `top_k` | int |
| `created_at` | datetime |
| `started_at` | datetime \| null |
| `completed_at` | datetime \| null |
| `error` | string \| null |

### `RunDetail`

All `RunOut` fields plus:

| Field | Type |
| --- | --- |
| `combinations` | array of `CombinationOut` |

### `CombinationOut`

| Field | Type |
| --- | --- |
| `id` | UUID |
| `run_id` | UUID |
| `strategy` | string |
| `params` | object |
| `label` | string |
| `status` | string |
| `progress` | float |
