# Retrieval & vector search (the retriever)

The **retriever** is how chunklab turns a question into the chunks most likely to
answer it. The same retrieval primitive powers three things: scoring combinations
during evaluation, the analyst chatbot, and the product assistant.

## Embeddings (what the vectors are)

Code: `app/core/embedding.py`. chunklab uses **FastEmbed** with
**`BAAI/bge-small-en-v1.5`**, a local 384-dimensional sentence-embedding model
(runs on CPU via ONNX, no API call, downloaded once to a shared cache). FastEmbed
L2-normalizes BGE embeddings, so cosine distance is exact.

- `embed_texts(texts) -> list[list[float]]` embeds a batch (used to embed chunks
  at indexing time).
- `embed_query(text) -> list[float]` embeds a single query (used at retrieval
  time).
- The dimension is fixed at `EMBEDDING_DIM = 384` and must match the `vector(384)`
  columns and the HNSW index.

## Indexing (storing chunk vectors)

During a run, each combination's chunks are embedded with `embed_texts` and
bulk-inserted into `results.chunks` with their `embedding vector(384)` column,
tagged by `combination_id` and `file_id`. An **HNSW** index (`vector_cosine_ops`,
`m=16, ef_construction=64`) is built on the embedding column so nearest-neighbour
search is fast and supports inserts without retraining.

## Retrieving (matching a question to chunks)

Code: `app/services/eval/retriever.py`, function
`retrieve(session, combination_id, query_vector, k)`.

1. Embed the question into a 384-d query vector.
2. Run a pgvector cosine nearest-neighbour query **scoped to one combination**:

   ```sql
   SELECT id, file_id, content, embedding <=> :qvec AS distance
   FROM results.chunks
   WHERE combination_id = :cid
   ORDER BY distance      -- smallest cosine distance first
   LIMIT :k;
   ```

   In SQLAlchemy this is `Chunk.embedding.cosine_distance(query_vector)` ordered
   ascending and limited to `k`.
3. Convert distance to a **relevance** score:
   `relevance = round(max(0, 1 − distance), 4)` (≈ cosine similarity, 0..1).
4. Return the top-k `RetrievedChunk(id, file_id, content, relevance)`.

`k` is the run's `top_k` (default 5). Filtering by `combination_id` is what keeps
the comparison fair — each combination is only ever searched against *its own*
chunks.

## Why cosine + HNSW

- **Cosine** because BGE embeddings are normalized and semantic similarity is
  about direction, not magnitude.
- **HNSW** (Hierarchical Navigable Small World) gives approximate
  nearest-neighbour search that is fast at query time and, unlike IVF, needs no
  training step and handles incremental inserts — a good fit for per-run indexing.

## Where the retriever is reused

1. **Evaluation** — for each QA question, retrieve top-k from each combination,
   then judge + score (see `04_qa_generation_and_evaluation.md`).
2. **Analyst chatbot** (project / run / compare scopes) — `context_builder.py`
   retrieves snippets from the run's *best* combination (highest nDCG) to ground
   answers about your experiments.
3. **Product assistant** (about scope) — the SAME pattern over
   `results.doc_chunks`: embed the user's question, cosine top-k over chunklab's
   own documentation, feed to the LLM (see `06_chat_and_product_assistant.md`).
   This is chunklab dogfooding its own RAG pipeline.

## Retrieval ≠ generation

Retrieval only *finds* chunks. The found chunks are then either scored
(evaluation) or passed as grounding context to an LLM (chat). The quality of what
is retrieved is exactly what chunklab measures across chunking strategies.
