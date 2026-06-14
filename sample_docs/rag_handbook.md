# The RAG Engineer's Handbook

Retrieval-augmented generation (RAG) grounds a language model in an external
knowledge store so its answers reflect your data instead of only its training.
A RAG system has three moving parts: an **indexing** pipeline, a **retrieval**
step, and a **generation** step.

## Indexing

Indexing turns documents into searchable vectors:

1. **Parse** each document into clean text (strip boilerplate, keep structure).
2. **Chunk** the text into passages small enough to embed but large enough to
   carry a complete idea.
3. **Embed** every chunk into a dense vector with an embedding model.
4. **Store** the vectors in a vector database with their source metadata.

The chunking step has an outsized effect on quality. Chunks that are too large
dilute the embedding with unrelated content and lower precision; chunks that are
too small fragment ideas and hurt recall.

## Retrieval

At query time the user's question is embedded with the *same* model, and the
nearest chunks are fetched by cosine similarity:

```python
qvec = embed(question)
hits = db.search(qvec, k=5)            # top-k nearest chunks
context = "\n\n".join(h.content for h in hits)
```

Common knobs are `k` (how many chunks), a similarity threshold, and optional
re-ranking of the candidates with a cross-encoder.

## Generation

The retrieved context is injected into the prompt and the model answers from it:

```text
System: Answer using ONLY the context. Cite sources.
Context: {context}
User: {question}
```

## Evaluation

Never ship a RAG change on vibes. Build a fixed question set and measure
retrieval with precision@k, recall@k, MRR, and nDCG, and answer quality with an
LLM judge scoring relevance and faithfulness. Track cost and latency too — a
configuration that is slightly more accurate but far more expensive is rarely
worth it.

## Pitfalls

- **Embedding mismatch** — index and query must use the same model.
- **Lost tables** — naive chunkers shred tables; structure-aware parsing helps.
- **Stale index** — re-embed when documents change.
- **Over-chunking** — more chunks is not always better; measure.
