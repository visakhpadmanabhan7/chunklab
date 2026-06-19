# QA generation & evaluation (how questions are formed and scored)

This is the heart of chunklab. To compare chunking strategies fairly, it builds
one **shared QA set** from your documents, then makes every combination answer the
same questions and scores how well each one's retrieval supports the answer.

## Step 1 — Forming the questions (QA generation)

Code: `app/services/eval/qa_generator.py`. Prompt: `QA_GENERATOR_PROMPT` in
`app/prompts/prompt_texts.py`.

1. **Sample passages.** `_sample_passages(text, n, window=900)` cuts up to `n`
   evenly-spaced ~900-character windows across the parsed document, so questions
   cover the whole file (not just the start). If the document is shorter than the
   window, the whole text is one passage.
2. **Generate one QA pair per passage.** For each passage the LLM (Groq
   `llama-3.3-70b-versatile` by default) is given `QA_GENERATOR_PROMPT` and the
   passage and must return strict JSON: `{"question": "...", "reference_answer":
   "..."}`. The prompt demands a specific, factual question answerable from the
   passage alone, a grounded reference answer, and no yes/no questions.
3. **Keep the gold span.** Each result becomes a `GeneratedQA` holding `question`,
   `reference_answer`, and the **source passage** plus its character offsets
   (`start`, `end`). That passage is the "gold context" — the ground truth used to
   compute retrieval metrics. LLM token usage is recorded for cost.

QA pairs are persisted as `results.qa_pairs` (with `source_chunk_text` and
`source_offset_start/end`).

**How many questions?** Settings control it: `QA_PAIRS_PER_FILE` (default 8) per
file, capped by `MAX_QA_PAIRS_PER_RUN` (default 10) so a run stays feasible on free
LLM tiers. The QA set is generated **once per run** and reused for every
combination — that is what makes the comparison fair.

You can also supply your **own** QA / ground truth instead of (or in addition to)
the auto-generated set via the run builder's ground-truth option (auto / mine /
both).

## Step 2 — Retrieving for each question

Code: `app/services/eval/retriever.py`. (Full detail in
`05_retrieval_and_vector_search.md`.)

For a given combination and a question:

1. The **question is embedded** with the same bge-small model (`embed_query`).
2. pgvector finds the **top-k** chunks belonging to *that combination* with the
   smallest cosine distance:
   `SELECT ... WHERE combination_id = :cid ORDER BY embedding <=> :qvec LIMIT :k`.
   `k` is the run's `top_k` (default 5).
3. Each retrieved chunk gets a relevance score `1 − cosine_distance`. The
   retrieved chunk ids + scores are saved as a `results.retrievals` row.

So "what retrieves the question against the chunks" is: embed the question →
cosine nearest-neighbour search over that combination's chunk vectors → top-k
chunks.

## Step 3 — Scoring the retrieval

Two independent scorers run on the retrieved chunks.

### (a) LLM-as-judge — `app/services/eval/judge.py`, `JUDGE_PROMPT`

The judge LLM is given the QUESTION, the REFERENCE ANSWER, and the numbered
retrieved CONTEXT chunks, and returns strict JSON scoring four dimensions from
0.0–1.0:

- **relevance** — are the retrieved chunks on-topic for the question?
- **faithfulness** — is the reference answer derivable from the retrieved context?
- **context_precision** — what fraction of retrieved chunks are actually useful?
- **context_recall** — does the context contain everything needed to answer?

Scores are clamped to [0,1]; a one-sentence feedback and token usage are kept.
This is the subjective, semantic view of quality. Saved as
`results.judge_evaluations`.

### (b) Computed IR metrics — `app/services/eval/metrics.py`

Objective metrics computed against the **gold passage** (no LLM). A retrieved
chunk counts as **relevant** when it comes from the *same file* as the gold
passage AND its word-set overlaps the gold passage by ≥ `RELEVANCE_THRESHOLD`
(0.5). With one gold passage per question there is a single relevant target.

Per question (`compute_for_query`, with `k` = top_k):

- **precision@k** = (# relevant retrieved) / k.
- **recall@k** = 1.0 if any relevant chunk was retrieved, else 0.0 (single gold
  target).
- **MRR** = 1 / (rank of the first relevant chunk), else 0.
- **nDCG@k** = DCG / IDCG, where DCG = Σ 1/log₂(rank+1) over relevant hits and
  IDCG is the ideal ordering (guarantees nDCG ≤ 1).
- **F2** = (5·P·R) / (4·P + R) — an F-measure that weights recall above precision.

## Step 4 — Aggregation

Per-question metrics are stored as `results.query_metrics` (the disaggregated /
"per-question" view). They are then **macro-averaged** across all questions into
one `results.metrics` row per combination — the judged means + computed-IR means +
`avg_retrieval_latency_ms`. Per-combination `combination_stats` (tokens, cost,
latencies) are aggregated alongside. The analytics dashboard, comparisons, and the
analyst chatbot all read from these aggregated `metrics` + `combination_stats`.

## Worked example

A run includes the combination `sentence·512/20` and the question *"What retry
settings does the client use?"*, generated from a gold passage in `client.md`.

1. The question is embedded; pgvector returns the 5 nearest chunks from
   `sentence·512/20`'s chunks.
2. Suppose the gold passage's content lands at retrieved rank 2, with word-overlap
   0.7 (≥ 0.5) and the same file → it counts as relevant.
   - precision@5 = 1/5 = 0.20, recall@5 = 1.0, MRR = 1/2 = 0.50,
     nDCG = (1/log₂3) / (1/log₂2) = 0.63, F2 = (5·0.2·1)/(4·0.2+1) = 0.56.
3. The judge reads the 5 chunks + reference answer and returns e.g. relevance
   0.8, faithfulness 0.9, context_precision 0.4, context_recall 1.0.
4. These join the other questions' scores; the macro-average becomes
   `sentence·512/20`'s row in `metrics`.

## Why two kinds of metrics?

Computed IR metrics are cheap, deterministic, and objective, but they depend on
the gold-passage word-overlap heuristic. The LLM judge captures semantic adequacy
that word overlap misses. Reporting both gives a fuller, cross-checked picture of
retrieval quality.
