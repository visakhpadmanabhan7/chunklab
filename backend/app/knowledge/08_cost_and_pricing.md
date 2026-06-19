# Cost & pricing

chunklab attaches a dollar figure to every chunking combination so that
cost-vs-accuracy tradeoffs are comparable across a run. The cost model lives in
`app/core/pricing.py`, and its default rates come from `app/core/config.py`.

A combination's cost has **two components**: a *notional* embedding cost and a
*real* LLM cost. They are summed into a total. This file explains both, lists the
per-provider pricing table, shows where the figures are stored, and works a small
example.

## The two cost components

1. **Embedding cost — notional (synthetic, not a real bill).**
   chunklab embeds chunks locally with FastEmbed (`BAAI/bge-small-en-v1.5`,
   384-dim) running on CPU. That has no per-token API charge — it is effectively
   free to run. But different combinations embed different volumes of text
   (more or larger chunks → more embedded tokens), and we still want that
   difference to show up as a cost. So embedding is priced at a **configurable
   reference rate** applied to the combination's total embedded tokens. This
   keeps combinations dollar-comparable; it is *not* a real expense.

2. **LLM cost — real (actual provider charges).**
   The QA generation and LLM-as-judge stages call a paid LLM API (default Groq
   `llama-3.3-70b-versatile`). Their cost is computed from the **actual token
   usage** (prompt + completion) returned by the provider in `response.usage`,
   priced at that provider/model's per-million-token rates. This is a true dollar
   figure. See `04_qa_generation_and_evaluation.md` for how those token counts
   are captured.

## Formulas

### Embedding cost

```
embedding_cost = total_tokens / 1000 * EMBED_COST_PER_1K
```

- `total_tokens` is the combination's total embedded token count.
- `EMBED_COST_PER_1K` default is **`0.00002`** ($ per 1k tokens), from
  `config.py`.
- Implemented as `embedding_cost(total_tokens)`, rounded to 6 decimals.

### LLM cost

```
llm_cost = prompt_tokens / 1_000_000 * INPUT_COST_PER_M
         + completion_tokens / 1_000_000 * OUTPUT_COST_PER_M
```

- `INPUT_COST_PER_M` / `OUTPUT_COST_PER_M` are the per-million-token input and
  output rates for the chosen provider/model (see the pricing table below).
- Implemented as `llm_cost(provider, model, prompt_tokens, completion_tokens)`,
  rounded to 6 decimals.
- `groq_cost(prompt_tokens, completion_tokens)` is a backwards-compatible helper
  that calls `llm_cost("groq", GROQ_MODEL, ...)` for the default Groq model.

### Total

```
total_cost = embedding_cost + judge_cost
```

The LLM component recorded against a combination is the **judge** cost (the
per-combination judge calls). QA generation is run once per run and shares its
token usage at the run level; the per-combination `total_cost` is
embedding + judge.

## Per-provider pricing table

The real LLM rates live in the `_PRICING` table in `pricing.py`, keyed by
`(provider, model)` as `(input_per_1M, output_per_1M)` in USD:

| Provider | Model | Input $/1M | Output $/1M |
| --- | --- | --- | --- |
| groq | llama-3.1-8b-instant | 0.05 | 0.08 |
| groq | llama-3.3-70b-versatile | 0.59 | 0.79 |
| openai | gpt-4o-mini | 0.15 | 0.60 |
| openai | gpt-4o | 2.50 | 10.00 |
| openai | gpt-4.1-mini | 0.40 | 1.60 |
| anthropic | claude-3-5-haiku-latest | 0.80 | 4.00 |
| anthropic | claude-3-5-sonnet-latest | 3.00 | 15.00 |

These are approximate public list prices and are used purely for cost
accounting.

### Rate resolution and fallbacks

`llm_cost` resolves the rate in this order:

1. Exact `(provider, model)` match in `_PRICING`.
2. Otherwise the provider default from `_PROVIDER_DEFAULT`:
   - `groq` → `(0.59, 0.79)`
   - `openai` → `(0.15, 0.60)`
   - `anthropic` → `(0.80, 4.00)`
3. Otherwise the Groq config defaults `(GROQ_INPUT_COST_PER_M,
   GROQ_OUTPUT_COST_PER_M)`.

### Groq defaults from config

The default model is `llama-3.3-70b-versatile`, and the config defaults match its
table row:

- `GROQ_INPUT_COST_PER_M` = **`0.59`**
- `GROQ_OUTPUT_COST_PER_M` = **`0.79`**

All cost rates (`EMBED_COST_PER_1K`, `GROQ_INPUT_COST_PER_M`,
`GROQ_OUTPUT_COST_PER_M`) are configurable via settings — change them in `.env`
to re-price runs.

## Where costs are stored

Costs are aggregated during the worker pipeline and persisted to the
`results.combination_stats` table, one row per combination. The cost columns are:

- `embedding_cost_usd` — the notional embedding cost.
- `judge_cost_usd` — the real LLM (judge) cost.
- `total_cost_usd` — `embedding_cost_usd + judge_cost_usd`.

(All three are `Numeric(12, 6)`.) See `02_data_model.md` for the full
`combination_stats` schema, which also carries `chunk_count`, `total_tokens`,
`avg_tokens_per_chunk`, and the latency columns.

## Worked example

Suppose one combination produces:

- `total_tokens` = 50,000 embedded tokens.
- Judge calls totaling `prompt_tokens` = 120,000 and `completion_tokens` = 4,000,
  using the default Groq `llama-3.3-70b-versatile`.

**Embedding cost (notional):**

```
50000 / 1000 * 0.00002 = 50 * 0.00002 = 0.001  USD
```

**Judge cost (real, Groq default rates 0.59 / 0.79):**

```
120000 / 1_000_000 * 0.59 = 0.0708
  4000 / 1_000_000 * 0.79 = 0.00316
judge_cost = 0.0708 + 0.00316 = 0.07396  USD
```

**Total:**

```
total_cost = 0.001 + 0.07396 = 0.07496  USD
```

So `embedding_cost_usd ≈ 0.001`, `judge_cost_usd ≈ 0.073960`, and
`total_cost_usd ≈ 0.074960` for that combination.

## Bringing your own provider/model

The **real LLM cost changes** when you run against a different provider/model.
If the LLM is switched to, say, OpenAI `gpt-4o` or Anthropic
`claude-3-5-sonnet-latest`, `llm_cost` looks up that row in the pricing table and
applies its input/output rates — so the same token usage yields a different
judge cost (and different total). The **embedding cost is unaffected** by the LLM
choice: it is always the notional `EMBED_COST_PER_1K` rate over embedded tokens,
because embeddings remain local and free. A model not present in the table falls
back to the provider default, then to the Groq config defaults, as described
above.
