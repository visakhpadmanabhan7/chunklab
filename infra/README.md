# infra/

Infrastructure for running chunklab locally with Docker Compose. This directory holds the Postgres bootstrap SQL; the orchestration itself lives in the repo-root `docker-compose.yml`. This document covers the database init script, the named volumes and how to reset state, the healthchecks and startup ordering, and how this relates to the application's own startup bootstrap.

## Layout

```
infra/
  postgres/
    init.sql   # one-time, first-boot Postgres bootstrap
```

## `infra/postgres/init.sql`

This file is mounted into the Postgres container at `/docker-entrypoint-initdb.d/init.sql` (read-only):

```yaml
volumes:
  - ./infra/postgres/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
```

Scripts placed in `/docker-entrypoint-initdb.d/` are executed by the official Postgres entrypoint **exactly once — only when the data directory is empty**, i.e. on the very first boot of a fresh `pgdata` volume. On subsequent starts (when `pgdata` already contains a database cluster), the entrypoint skips this directory entirely.

The script (run against the `pgvector/pgvector:pg16` image) does the minimum needed to make the database usable before the backend connects:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS results;
```

- `CREATE EXTENSION vector` enables pgvector so that `vector(384)` columns and the HNSW index can exist.
- `core` and `results` are the two application schemas (see [Schemas](#schemas)).

Every statement uses `IF NOT EXISTS`, so the script is idempotent and harmless even if the application has already created these objects.

> Note: `init.sql` does **not** create tables or indexes. It only prepares the extension and schemas. Table and index creation is handled by the app at startup (see below).

## Application startup bootstrap (`init_db()`)

The container init script is a convenience so the `vector` extension is available the instant Postgres accepts connections. It is **not** the source of truth for the schema. The application owns that.

On every backend startup, the FastAPI lifespan in `app/main.py` calls `init_db()` from `app/db/setup_db.py`, which performs the full, idempotent bootstrap:

- `CREATE EXTENSION IF NOT EXISTS vector`
- `CREATE SCHEMA IF NOT EXISTS core` and `results`
- `create_all` for **both** SQLAlchemy metadatas (creates all `core.*` and `results.*` tables if missing)
- `CREATE INDEX` for the HNSW index on `results.chunks.embedding`
  (`vector_cosine_ops`, `m = 16`, `ef_construction = 64`)

Because `init_db()` re-runs and re-asserts everything on each boot, the app works against a fresh database even if `init.sql` had never run (e.g. an externally provisioned Postgres). There is **no Alembic in v0.1** — this idempotent startup bootstrap replaces migrations. Schema changes are made by editing the SQLAlchemy models; `create_all` only *adds* missing tables and does not alter existing ones, so destructive changes require a volume reset (below).

### Schemas

| Schema    | Tables |
|-----------|--------|
| `core`    | `projects`, `files`, `parsed_documents`, `runs`, `run_combinations` |
| `results` | `chunks` (has `embedding vector(384)`), `combination_stats`, `qa_pairs`, `retrievals`, `judge_evaluations`, `metrics` |

## Volumes

Compose declares four named volumes that hold all persistent state:

| Volume      | Mounted in        | Path                         | Holds |
|-------------|-------------------|------------------------------|-------|
| `pgdata`    | postgres          | `/var/lib/postgresql/data`   | The Postgres cluster: all projects, files, runs, chunks, embeddings, metrics. |
| `redisdata` | redis             | `/data`                      | Redis persistence — the arq job queue plus run progress pub/sub state. |
| `uploads`   | backend + worker  | `/app/data/uploads`          | Uploaded source files (`STORAGE_DIR`). Shared so the worker can parse what the backend saved. |
| `hf_cache`  | backend + worker  | `/root/.cache`               | HuggingFace / FastEmbed model cache (e.g. `BAAI/bge-small-en-v1.5`, tokenizers). Shared so the model downloads once and both services reuse it. |

`uploads` and `hf_cache` are deliberately shared between the `backend` and `worker` containers (which run the *same* image) so uploaded files are visible to the worker and the embedding model is downloaded only once.

## Resetting state

To wipe **all** persistent state and start completely fresh — this also triggers `init.sql` to run again on the next boot, since `pgdata` will be empty:

```bash
docker compose down -v
```

The `-v` flag removes the named volumes (`pgdata`, `redisdata`, `uploads`, `hf_cache`). Use this when you want a clean database, an empty queue, no uploaded files, and a cold model cache.

Notes and selective resets:

- `docker compose down` **without** `-v` stops and removes containers but **keeps** the volumes. On the next `up`, Postgres data survives and `init.sql` is **not** re-run (the data directory is non-empty); the app's `init_db()` still runs and re-asserts the schema.
- To reset only the database (and re-run `init.sql`): `docker compose down` then `docker volume rm chunking_exp_pgdata` (Compose prefixes volume names with the project directory name; confirm with `docker volume ls`), then `docker compose up`.
- Re-downloading the embedding model is avoidable: keep `hf_cache` and only remove `pgdata`/`redisdata` if you want to preserve the model cache.

## Healthchecks and `depends_on` ordering

Each service waits for its dependencies to be healthy before starting, so the stack comes up in a correct order rather than racing.

| Service   | Healthcheck                                                  | Depends on |
|-----------|-------------------------------------------------------------|------------|
| postgres  | `pg_isready -U <user> -d <db>` (5s interval, 12 retries)     | — |
| redis     | `redis-cli ping` (5s interval, 12 retries)                   | — |
| backend   | `urllib.request.urlopen('http://localhost:8000/health')` (10s interval, 10 retries) | postgres (healthy), redis (healthy) |
| worker    | none                                                         | postgres (healthy), redis (healthy), backend (started) |
| frontend  | none                                                         | backend (healthy) |

Resulting startup sequence:

1. **postgres** and **redis** start and run their healthchecks. On a first boot, Postgres also executes `init.sql` during its initialization.
2. **backend** starts only once both postgres and redis report `service_healthy`. On boot it runs `init_db()` (extension, schemas, tables, HNSW index) and exposes `/health`.
3. **worker** starts once postgres and redis are healthy and backend has merely *started* (`service_started`, not healthy) — so the worker doesn't block on the backend's full health, but the database is guaranteed ready before it dequeues jobs.
4. **frontend** starts only once the backend is `service_healthy`, so the UI never comes up pointing at an unready API.

The `service_healthy` gates mean the backend never tries to connect to a Postgres that isn't accepting connections, which matters because `init.sql` (extension creation) needs to be in place before `init_db()` runs.

## Ports

| Service  | Host port |
|----------|-----------|
| frontend | 3000      |
| backend  | 8000      |
| postgres | 5432      |
| redis    | 6379      |

## Common commands

```bash
# Build and start the whole stack
docker compose up --build

# Tear down, preserving data (volumes kept)
docker compose down

# Tear down and wipe all state (volumes removed; init.sql re-runs next boot)
docker compose down -v

# Seed sample data (after the stack is up)
docker compose exec backend python -m app.scripts.seed
```
