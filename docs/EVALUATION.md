# Evaluation Methodology

This document describes how chunklab evaluates the quality of a chunking
strategy end-to-end. The goal is to make different chunking configurations
("combinations") **comparable** along two axes: how well a retriever can find
answer-bearing context using their chunks, and how much that configuration
costs.

Evaluation is run by the arq worker pipeline
(`app/workers/run_pipeline.py`) once per run. A single shared QA set is
generated for the run's files, then **every combination is scored against that
same set**, so differences in scores reflect differences in chunking — not
differences in questions.

The pipeline produces two complementary families of scores per combination:

1. **LLM-as-judge scores** — a Groq model rates retrieval quality on four
   subjective 0..1 dimensions.
2. **Computed IR metrics** — deterministic, ground-truth-based metrics
   (precision@k, recall@k, MRR, nDCG@k, F2) over the gold passage each question
   was generated from.

Source modules:

| Stage | Module |
| --- | --- |
| QA generation | `app/services/eval/qa_generator.py` |
| Retrieval | `app/services/eval/retriever.py` |
| LLM-as-judge | `app/services/eval/judge.py` |
| Computed IR metrics | `app/services/eval/metrics.py` |
| Prompts | `app/prompts/prompt_texts.py` |
| Pricing | `app/core/pricing.py` |

---

## 1. QA generation (grounded questions with gold spans)

Module: `app/services/eval/qa_generator.py`
Prompt: `QA_GENERATOR_PROMPT`

The evaluation set is **auto-generated** from each file's parsed text. It is
generated **once per run** (not per combination) so the question set is shared
across all chunking configurations.

### Passage sampling

`_sample_passages(text, n, window=900)` selects up to `n` passages of `window`
(default 900) characters, spread evenly across the document:

- The text is stripped. If empty, no passages are produced.
- If the document is shorter than `window`, the whole document is the single
  passage at offset `0`.
- Otherwise the usable span is `span = len(text) - window`, the stride is
  `step = max(span // n, 1)`, and passage `i` starts at
  `start = min(i * step, span)`. This yields evenly spaced, roughly
  non-overlapping windows covering the document from start to end.

The number of passages per file is controlled by `QA_PAIRS_PER_FILE` (default
`8`), passed as `n`.

### Question + reference answer extraction

For each sampled passage, the LLM (`get_llm()`, Groq
`llama-3.3-70b-versatile`) is called via `llm.extract(QA_GENERATOR_PROMPT,
passage)`. The prompt instructs the model to produce **one** specific factual
question answerable from the passage alone, plus a concise grounded reference
answer, as strict JSON:

```json
{"question": "...", "reference_answer": "..."}
```

The response is parsed with `parse_json`. A passage is discarded (logged at
warning level, loop continues) if the call fails, the JSON is not an object, or
either `question` or `reference_answer` is blank. This makes generation
resilient to occasional network/parse failures without aborting the run.

### The gold span

Each accepted pair becomes a `GeneratedQA`:

```python
@dataclass
class GeneratedQA:
    question: str
    reference_answer: str
    source_chunk_text: str   # the sampled passage = GOLD context
    start: int               # char offset in the source document
    end: int                 # start + len(passage)
    prompt_tokens: int
    completion_tokens: int
```

The **passage the question was generated from is retained as the gold
context** (`source_chunk_text`), together with its character offsets. This gold
span is the ground truth for the computed IR metrics in Section 4 — a retrieved
chunk is "correct" when it overlaps this passage. Token usage from the
generation call is captured for cost accounting.

---

## 2. Retrieval (pgvector cosine top-k)

Module: `app/services/eval/retriever.py`

Each combination's chunks are embedded and stored as `vector(384)` rows in the
`results.chunks` table (FastEmbed `BAAI/bge-small-en-v1.5`). Each question is
embedded once per run (`precompute question embeddings` step in the pipeline).

`retrieve(session, combination_id, query_vector, k)` runs a pgvector
nearest-neighbour query **scoped to a single combination**:

```sql
SELECT id, file_id, content, embedding <=> :query AS distance
FROM results.chunks
WHERE combination_id = :combination_id
ORDER BY distance
LIMIT :k;
```

(`<=>` is pgvector cosine distance, exposed via
`Chunk.embedding.cosine_distance(query_vector)`. An HNSW index with
`vector_cosine_ops`, `m=16`, `ef_construction=64` backs this query.)

The result is the top `k` chunks (where `k` is the run's `top_k`, default
`TOP_K=5`). Cosine distance is converted to a similarity score for display:

```
relevance = max(0.0, 1.0 - distance)      # clamped, rounded to 4 dp
```

Each retrieved set is persisted as `Retrieval` rows before judging.

---

## 3. LLM-as-judge (four 0..1 dimensions, temperature 0)

Module: `app/services/eval/judge.py`
Prompt: `JUDGE_PROMPT`

For each question, the top-`k` retrieved chunk contents are formatted as a
numbered context block (`[1] ...`, `[2] ...`, or `(none)` if empty) and sent to
the judge along with the question and the reference answer:

```
QUESTION:
{question}

REFERENCE ANSWER:
{reference_answer}

CONTEXT:
[1] {chunk 1}

[2] {chunk 2}
...
```

The judge call uses `llm.extract(JUDGE_PROMPT, user_input)`. The LLM is the same
Groq `llama-3.3-70b-versatile` model, **run at temperature 0** so judgments are
as deterministic and reproducible as the model allows.

The judge returns strict JSON scoring four dimensions, each in `[0.0, 1.0]`:

| Dimension | Question it answers |
| --- | --- |
| `relevance` | Are the retrieved chunks on-topic for the question? |
| `faithfulness` | Is the reference answer supported by / derivable from the context? |
| `context_precision` | What fraction of the retrieved chunks are actually useful? |
| `context_recall` | Does the context contain everything needed to answer? |

```json
{"relevance": 0.0, "faithfulness": 0.0, "context_precision": 0.0, "context_recall": 0.0, "feedback": "one short sentence"}
```

### Robustness and clamping

Each numeric field is run through `_clamp`, which coerces to float and clamps
into `[0.0, 1.0]`, defaulting to `0.0` on bad/missing values. `feedback` is
coerced to string and truncated to 500 chars. If the call fails or the response
is not a JSON object, a default all-zero `JudgeResult` is returned so the
pipeline never crashes on a single bad judgment.

### Token-usage capture

Every judge call records `prompt_tokens` and `completion_tokens` from the Groq
`response.usage`. These feed the real Groq judge cost (Section 5). Judgments are
persisted as `JudgeEvaluation` rows; their means become the judged metrics in
`results.metrics`.

---

## 4. Computed IR metrics (deterministic, gold-passage ground truth)

Module: `app/services/eval/metrics.py`

Unlike the judge (subjective, LLM-scored), these metrics are **deterministic**
and grounded in the gold passage from Section 1. They are adapted from the
final-thesis `textbook_log.py` precision/recall/F2 implementation.

### Relevance definition (text overlap, same file)

A retrieved chunk is counted **relevant** to a question iff **both** hold:

1. It comes from the **same file** as the gold passage
   (`chunk.file_id == gold_file_id`), and
2. Its text **substantially overlaps** the gold passage by word-set overlap.

Word-set overlap (`is_relevant`):

```
words(t)  = set of lowercased \w+ tokens in t
overlap   = | words(gold) ∩ words(chunk) | / | words(gold) |
relevant  ⇔  overlap ≥ RELEVANCE_THRESHOLD       (RELEVANCE_THRESHOLD = 0.5)
```

Guards: gold passages with fewer than 5 distinct words, and empty chunks, are
treated as not relevant (too small to score meaningfully).

So per query we build a list of boolean `flags` over the top-`k` retrieved
chunks, where `flags[i]` is true when retrieved chunk `i` is relevant. Let
`num_relevant = sum(flags)` and `k` the cutoff.

### Per-query formulas

Because there is exactly **one gold passage per question**, recall is binary
(was the single gold target hit at all?) and the ideal DCG is `1`.

**Precision@k** — fraction of the top-`k` that are relevant:

```
precision@k = num_relevant / max(k, 1)
```

**Recall@k** — single-gold, binary (1 if any relevant chunk was retrieved):

```
recall@k = 1.0  if num_relevant > 0  else 0.0
```

**MRR** — reciprocal rank of the first relevant chunk (ranks are 1-based; 0 if
none relevant):

```
MRR = 1 / rank_of_first_relevant      (0 if no relevant chunk in top-k)
```

**nDCG@k** — binary gains, log2 rank discount; ideal DCG is 1 (one relevant
item, ideally at rank 1 → `1/log2(2) = 1`):

```
DCG  = Σ over i where flags[i] is true of  1 / log2(i + 2)     (i is 0-based)
IDCG = 1.0
nDCG@k = DCG / IDCG
```

**F2** — the F-measure weighted toward recall (β = 2):

```
F2 = (5 · precision · recall) / (4 · precision + recall)      (0 if precision + recall = 0)
```

All per-query values are rounded to 4 decimal places and returned as a
`QueryMetrics` dataclass.

### Macro-averaging

`macro_average(per_query)` averages each metric **equally across all
questions** (every query weighted the same, regardless of difficulty):

```
metric_macro = (1 / N) · Σ_q metric_q          for each of the 5 metrics
```

If there are no queries, all five metrics are `0.0`. The macro-averaged
`QueryMetrics` for a combination is stored alongside the judged means in
`results.metrics`.

---

## 5. Cost model

Module: `app/core/pricing.py`

Each combination is scored on cost so that cost-vs-accuracy tradeoffs are
visible (see `analytics/tradeoff`). Cost has two components — one notional, one
real.

### Notional embedding cost

Local embeddings (FastEmbed) are **free** to run, but a per-combination embedding
volume still differs (more/larger chunks → more embedded tokens). To keep
combinations dollar-comparable, embedding is priced at a **notional** rate:

```
embedding_cost = total_tokens / 1000 · EMBED_COST_PER_1K
```

with `EMBED_COST_PER_1K` default `0.00002`. This is a synthetic, comparable
unit, not a real bill.

### Real Groq judge cost

The judge calls hit a paid API, so their cost is **real**, computed from the
captured token usage and Groq's per-million-token rates:

```
groq_cost = prompt_tokens / 1e6 · GROQ_INPUT_COST_PER_M
          + completion_tokens / 1e6 · GROQ_OUTPUT_COST_PER_M
```

with defaults `GROQ_INPUT_COST_PER_M = 0.59` and `GROQ_OUTPUT_COST_PER_M =
0.79` (for `llama-3.3-70b-versatile`).

### Total

```
total_cost = embedding_cost + judge_cost
```

These figures are aggregated into `CombinationStats` (tokens, cost, latency)
during the pipeline.

---

## 6. Limitations

The methodology trades absolute rigor for a fully automated, self-contained
benchmark. Keep these caveats in mind when reading scores:

- **Auto-generated ground truth.** Both the questions and the reference answers
  are produced by an LLM from sampled passages. They are not human-authored or
  human-validated, so question quality, answerability, and grounding vary.
- **Single gold passage per question.** Each question has exactly **one** gold
  span. This makes recall binary (hit/miss), fixes nDCG's IDCG at 1, and means
  the IR metrics cannot reward retrieving multiple genuinely-relevant chunks
  spread across a document.
- **Overlap-based relevance is lexical.** The computed metrics use word-set
  overlap (≥ 0.5 of the gold's words), not semantics. A chunk that paraphrases
  the gold passage with different wording can be scored irrelevant, and the same
  file is required.
- **Passage sampling is positional.** Passages are evenly spaced fixed-width
  windows, so the QA set reflects document position rather than topical
  importance; some sections may be over- or under-sampled.
- **LLM-as-judge subjectivity.** Even at temperature 0, judge scores reflect the
  model's interpretation and can drift across model versions; they are best used
  comparatively within a single run rather than as absolute quality figures.
- **Notional embedding cost.** The embedding component of `total_cost` is a
  synthetic comparison unit, not a real expense; only the Groq judge cost is a
  true dollar figure.
