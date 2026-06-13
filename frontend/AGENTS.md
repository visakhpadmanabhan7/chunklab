# Frontend AGENTS.md

Notes for agents working in `frontend/` (Next.js 15 App Router, React 19, TypeScript, Tailwind v3).

## Client vs. Server components

- Components are **Server Components by default**. Add `"use client"` at the top of any file that uses hooks, state, effects, browser APIs, or event handlers.
- `useParams`, `usePathname`, `useSearchParams` (and other `next/navigation` hooks) are **client-only** — they only work inside a `"use client"` component.
- `useSearchParams` must be wrapped in a `<Suspense>` boundary or it will deopt the whole route to client-side rendering.

## Environment variables

- `NEXT_PUBLIC_*` vars are **inlined at build time**, not read at runtime. The API base URL (`NEXT_PUBLIC_API_BASE_URL`) is **baked into the bundle when the image is built**.
- Changing the API URL requires a **rebuild**, not just a restart. In Docker it is passed as a build arg (`NEXT_PUBLIC_API_BASE_URL=http://localhost:8000`) in `Dockerfile.frontend`.
- Non-`NEXT_PUBLIC_` vars are server-only and never reach the browser.

## Docker / build

- The app uses Next.js **standalone output** (`output: "standalone"`) for the Docker image. Keep that config — the runtime image copies `.next/standalone`.
- Verify production builds locally with `npm run build` before assuming a change works; some issues (Suspense, server/client boundaries) only surface at build time.

## Live data

- Run progress uses native **`EventSource` (SSE)** against `/api/v1/runs/{id}/progress/stream`.
- Chat uses **`fetch` + `ReadableStream`** to read the `text/plain` token stream from `/api/v1/chat/stream`.
- Both are browser APIs, so the consuming components must be `"use client"`.

## General

- Prefer reading the **installed Next.js docs / types in `node_modules/next`** before using an unfamiliar API — Next 15 / React 19 behavior differs from older versions (async `params`/`searchParams`, caching defaults, etc.).
- Data fetching/caching uses TanStack Query; charts use Recharts; client state uses Zustand.
