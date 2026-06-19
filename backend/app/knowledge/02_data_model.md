# Data model

chunklab uses a single Postgres database with the **pgvector** extension and
**two schemas** that separate inputs from experiment outputs. One shared
SQLAlchemy `MetaData` holds both schemas so cross-schema foreign keys resolve when
tables are created.

## Schema: core (inputs & run definitions)

- **projects** — `id, user_id, name, description, created_at, updated_at`. The
  top-level container.
- **files** — `id, project_id→projects, filename, storage_path, mime, size,
  status, parser_used`. An uploaded document.
- **parsed_documents** — `id, file_id→files (unique), clean_text, char_count,
  page_count`. The parsed plain text. The original file is discarded after parsing.
- **runs** — `id, project_id→projects, name, config (JSONB), embedding_model,
  top_k, status, progress, total_combinations, created_at`. One experiment.
  `config` stores the full requested matrix for audit.
- **run_combinations** — `id, run_id→runs, strategy, params (JSONB), label,
  status, progress`. One cell of the matrix (one strategy + params). `label` is the
  human id like `sentence·512/20` and is unique within a run.

## Schema: results (experiment outputs)

- **chunks** — `id, combination_id→run_combinations, file_id→files, chunk_index,
  content, token_count, char_count, embedding vector(384)`. Every chunk produced
  by a combination, with its embedding. This is the table the retriever searches.
- **combination_stats** — per-combination (unique) totals: `chunk_count,
  total_tokens, avg_tokens_per_chunk, embedding_cost_usd, judge_cost_usd,
  total_cost_usd, chunk_latency_ms, embed_latency_ms, eval_latency_ms`.
- **qa_pairs** — the evaluation set: `id, run_id, file_id, question,
  reference_answer, source_chunk_text, source_offset_start, source_offset_end`.
  The "gold passage" each question came from is kept for scoring.
- **retrievals** — what a combination retrieved for a question: `id,
  combination_id, qa_pair_id, retrieved_chunk_ids (UUID[]), scores (float[]),
  latency_ms`.
- **judge_evaluations** — LLM-judge output per retrieval (unique): `relevance,
  faithfulness, context_precision, context_recall, judge_feedback, judge_model,
  judge_tokens_in, judge_tokens_out`.
- **query_metrics** — per-question computed + judged metrics for one combination
  (the disaggregated view): `precision_at_k, recall_at_k, mrr, ndcg_at_k, f2,
  relevance, faithfulness, context_precision, context_recall`.
- **metrics** — per-combination (unique) aggregated scoreboard: judged means
  (`relevance, faithfulness, context_precision, context_recall`) + computed IR
  means (`precision_at_k, recall_at_k, mrr, ndcg_at_k, f2`) +
  `avg_retrieval_latency_ms`.
- **doc_chunks** — the product assistant's own knowledge base: `source, title,
  section, content, token_count, corpus_version, embedding vector(384)`.
  chunklab's documentation, embedded for the "about" chatbot (see 06).

## Vector storage & index

The embedding columns are `vector(384)` (matching `EMBEDDING_DIM` = 384, the
bge-small model). An **HNSW** index with cosine ops (`m=16, ef_construction=64`)
accelerates similarity search on both `results.chunks` and `results.doc_chunks`.
Relevance is reported as `1 − cosine_distance`.

## Lifecycle & cascade

Deleting a project cascades to its files, parsed docs, runs, combinations, and all
results (chunks, retrievals, judge evaluations, metrics) via `ON DELETE CASCADE`.
The schema is created idempotently at startup by `init_db()` (`CREATE EXTENSION
vector`, `CREATE SCHEMA`, `create_all`, then the HNSW indexes) — there is no
migration framework in v0.1.
