# chunklab — Frontend (CLAUDE.md)

Next.js 15 (App Router) + TypeScript + Tailwind v3 UI for chunklab. Lets you create projects, upload files, define a matrix of chunking strategies, launch evaluation runs, watch live progress, and explore/compare results — plus a streaming chat over run results.

Stack: Next 15 (App Router, React 19) · TypeScript · Tailwind v3 · TanStack Query (server state) · Zustand (draft builder state) · Recharts (charts) · native `EventSource` (live progress) · `fetch` + `ReadableStream` (chat). The backend lives at `../backend` (FastAPI, all routes under `/api/v1`).

## Run

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build (Next standalone in Docker)
npm run start    # serve the production build
npm run lint
```

The frontend talks to the backend at `NEXT_PUBLIC_API_BASE_URL` (default `http://localhost:8000`). Set this in `.env.local` for dev; in Docker it is baked at build time via the `NEXT_PUBLIC_API_BASE_URL` build arg. Backend must be running (`docker compose up --build` from repo root brings up the whole stack on ports 3000/8000/5432/6379).

## App Router structure (`src/app`)

| Route | File | Purpose |
| --- | --- | --- |
| `/` | `page.tsx` | landing/redirect |
| `/projects` | `projects/page.tsx` | list + create projects |
| `/projects/[projectId]` | `projects/[projectId]/page.tsx` (+ `layout.tsx`) | project overview; the per-project layout is the shell/nav for everything below |
| `/projects/[projectId]/files` | `.../files/page.tsx` | upload + list files (multipart, field name `upload`) |
| `/projects/[projectId]/runs` | `.../runs/page.tsx` | list runs for the project |
| `/projects/[projectId]/runs/new` | `.../runs/new/page.tsx` | run builder — pick files + assemble the combination matrix |
| `/projects/[projectId]/runs/[runId]` | `.../runs/[runId]/page.tsx` | single run: live progress while running, results dashboard when done |
| `/projects/[projectId]/runs/[runId]/compare` | `.../runs/[runId]/compare/page.tsx` | compare combinations within a run (charts) |
| `/projects/[projectId]/chat` | `.../chat/page.tsx` | streaming chat scoped to project/run/compare |

`providers.tsx` wraps the app in the TanStack Query `QueryClientProvider` (mounted in the root `layout.tsx`). `globals.css` holds Tailwind directives + the shared component classes.

Supporting code: `src/components` (`results/ResultsDashboard.tsx`, `runs/RunProgress.tsx`, `ui/{Badge,Progress,Spinner}.tsx`), `src/hooks`, `src/lib`, `src/store`.

## Conventions (follow these)

### All network calls go through `src/lib/api.ts`
Never `fetch` the backend directly from components. `api.ts` exports one typed function per endpoint and centralizes the base URL + error handling.

- `API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000"`, and `V1 = ${API_BASE}/api/v1`.
- Internal `req<T>(path, init)` sets JSON headers, throws `Error(body.detail || statusText)` on non-2xx, returns `undefined` for 204.
- Projects: `listProjects`, `getProject`, `createProject`, `deleteProject`.
- Files: `listFiles`, `deleteFile`, and `uploadFile(projectId, file)` (uses `FormData` with field name `upload` — bypasses `req` so the browser sets the multipart boundary; do not set `Content-Type` manually).
- Runs: `createRun(projectId, RunCreatePayload)`, `listRuns`, `getRun`, `getCombinations`, `cancelRun`. `RunCreatePayload = { name, top_k?, combinations: {strategy, params}[], file_ids: string[] | "all" }` — mirrors the backend `RunCreate`.
- Results/analytics: `getResults`, `getTradeoff`, `getProgressSnapshot`, `getCombinationChunks` (chunks come back without vectors).
- `progressStreamUrl(runId)` returns the SSE URL (`.../runs/{id}/progress/stream`).
- Chat: `chatStream(ChatPayload)` returns the raw `Response` (caller reads the stream).

When adding an endpoint to the backend, add a matching typed wrapper here — do not inline the path elsewhere.

### Types in `src/lib/types.ts`
All shared API/domain types (`Project`, `FileItem`, `Run`, `Combination`, `RunResults`, `TradeoffPoint`, `ProgressEvent`, `DraftCombination`, …) live here and are imported with the `@/` alias. Keep them in sync with the backend Pydantic schemas. `src/lib/format.ts` holds display helpers (numbers, costs, labels).

### Strategy catalog in `src/lib/strategies.ts` MUST mirror the backend
This is the single source of truth for the run builder UI and must stay byte-for-byte compatible with the backend chunking registry.

- `STRATEGIES: StrategyDef[]` lists the five strategies — `sentence`, `character`, `recursive`, `token`, `semantic` — each with the param fields (`key`, `min`, `max`, `default`) the backend accepts. **Strategy `id`s and param `key`s must equal the backend's** (`size`/`overlap` for sentence/character/token; `chunk_size`/`overlap` for recursive; `breakpoint_percentile` for semantic).
- `buildLabel(strategy, params)` **must produce exactly the same string as the backend `label()`** — labels are used for display *and* de-duplication, so any drift breaks dedup and result joins. Current format:
  - `sentence·{size}/{overlap}`
  - `character·{size}/{overlap}`
  - `token·{size}/{overlap}`
  - `recursive·{chunk_size}/{overlap}`
  - `semantic·pct{breakpoint_percentile}`
  - The separator is `·` (U+00B7 middle dot), not an ASCII dot.

If you change a strategy name, param, or label format, change it in the backend (`backend/app/services/chunking/`) and here together.

### Server state via TanStack Query
Fetch with `useQuery`/`useMutation` keyed by resource (e.g. `["runs", projectId]`, `["results", runId]`); invalidate on mutations (create/delete project, upload file, create/cancel run). Do not duplicate server data into React state or Zustand.

### Draft combination matrix in Zustand (`src/store/builder-store.ts`)
The run-builder's in-progress list of combinations is **client-only draft state**, kept in `useBuilderStore`:

- `combos: DraftCombination[]`, `add(c) -> boolean` (returns `false` and no-ops on duplicate `label`), `remove(label)`, `clear()`.
- Dedup is by `label`, so build draft labels with `buildLabel(...)` from `strategies.ts`.
- On submit, map the drafts to `{ strategy, params }[]` for `createRun`; clear the store after a successful create.

Use Zustand only for this ephemeral builder state — everything that comes from the API stays in TanStack Query.

### Live progress via native `EventSource` (`src/hooks/useRunProgress.ts`)
`useRunProgress(runId, enabled)` opens an `EventSource` to `progressStreamUrl(runId)` and reduces the backend's `ProgressEvent` stream into `{ runStatus, runPct, combos, files, logs, connected }`.

- Event types: `run {status, pct}`, `combo {comboId, label, status, pct}`, `file {key, comboId, fileId, stage, status, pct}`, `log {key, level, message}`.
- The connection auto-closes when `runStatus` is terminal (`completed` | `failed` | `canceled`); logs are capped at the last ~40 entries.
- `enabled` gates the effect (e.g. only stream while a run is active); the hook is `"use client"`. Use it from the run-detail page / `RunProgress` component.

### Chat via `fetch` + `ReadableStream`
Chat is **not** EventSource. Call `chatStream(payload)` and read `response.body` with a `ReadableStream` reader + `TextDecoder`, appending decoded tokens to the assistant message as they arrive (`text/plain` token stream). `ChatPayload.scope` is `project | run | compare` with the corresponding `project_id` / `run_id` / `run_ids`, plus `message` and `history`.

### Charts via Recharts
All visualizations (comparison bars, cost-vs-accuracy tradeoff scatter, cross-run summaries) use Recharts. Tradeoff points come from `getTradeoff(runId)`; comparison data from `getResults(runId)`.

### Styling via Tailwind + shared classes (`globals.css`)
Use Tailwind utility classes inline. Reach for the shared `@layer components` classes for consistency instead of re-deriving them:

- `.card` — bordered white panel with shadow.
- `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-ghost` — buttons (all extend `.btn`).
- `.input` — text inputs; `.label` — small uppercase field labels.
- `.badge` — pill; combine with a color utility (see `ui/Badge.tsx`) for status colors.
- Brand color is the `brand-*` palette (configured in `tailwind.config`).

## Adding a feature — checklist
1. Add/extend the typed wrapper in `src/lib/api.ts` and the type in `src/lib/types.ts`.
2. Fetch via TanStack Query (new query key + invalidation), not raw `fetch`.
3. If it touches strategies/labels, update `src/lib/strategies.ts` together with the backend.
4. Build UI from the `.card`/`.btn-*`/`.input`/`.badge` classes; use Recharts for charts.
5. Keep client-only draft state in Zustand; everything server-derived stays in Query.
