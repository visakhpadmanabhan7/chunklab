# Chunking strategies

chunklab compares text-chunking strategies head-to-head for RAG. Each strategy is
a small self-registering class behind a common interface; an **expander** turns a
matrix of combination specs into concrete, labelled, de-duplicated cells; and the
worker then runs each cell through the embed → retrieve → judge → metrics pipeline
(see `04_pipeline_and_runs.md` and `06_evaluation_and_judging.md`).

All code lives under `backend/app/services/chunking/`. The frontend mirror used by
the run builder is `frontend/src/lib/strategies.ts`, which must stay byte-for-byte
compatible with the backend (strategy ids, param keys, and label formats).

## The strategy interface

A chunking strategy satisfies the `ChunkingStrategy` protocol in `base.py`:

```python
@runtime_checkable
class ChunkingStrategy(Protocol):
    name: str
    def split(self, text: str, params: dict) -> list[str]: ...
    def label(self, params: dict) -> str: ...
```

- **`name`** — the registry key (e.g. `"sentence"`). A run spec's `strategy` field
  references it, and the frontend `id` mirrors it.
- **`split(text, params)`** — returns raw chunk **strings**. It is string-in /
  string-list-out: no offsets, no token counts, no DB objects. Those are layered on
  afterward by `assemble` and the worker.
- **`label(params)`** — a stable, human-readable identifier for one parameter set.
  Labels are the **dedup key** in the expander and the display key in the UI and
  reports, so the backend `label()` and the frontend `buildLabel()` must agree
  character-for-character.

### `params` is intentionally loose

`params` is a plain `dict`. Each strategy reads what it needs via
`params.get(key, default)` and tolerates **aliases** so a request can use either
the natural key or a generic one. For example `sentence` accepts `size` **or**
`chunk_size`; `recursive` accepts `chunk_size`/`size` and `overlap`/`chunk_overlap`.
This keeps the run-create API forgiving without a rigid per-strategy schema.

### `assemble` — wrapping raw pieces into `Chunk`s

`split` returns bare strings. The worker calls `assemble(text, pieces)` to wrap
each piece into a `Chunk(index, content, start, end)` and recover char offsets
against the source document by walking the pieces in order with
`text.find(piece, cursor)`, advancing the cursor by 1 after each hit so overlapping
chunks still resolve to plausible spans. Empty/whitespace-only pieces are skipped;
pieces that can't be located fall back to `(0, 0)`. Offsets are best-effort and
feed the gold-span overlap relevance check in `metrics.py` — they need not be exact.

## The registry pattern

Strategies register themselves at import time (`registry.py`):

```python
STRATEGY_REGISTRY: dict[str, ChunkingStrategy] = {}

def register(strategy):           # called at module bottom: register(SentenceStrategy())
    STRATEGY_REGISTRY[strategy.name] = strategy
    return strategy

def get_strategy(name):           # raises KeyError listing available names if unknown
    ...

def list_strategies() -> list[str]:   # sorted names
    ...
```

Each strategy module ends with one line that instantiates and registers the class,
e.g. `register(SentenceStrategy())`. The package `app/services/chunking/__init__.py`
imports all five modules, so importing the package populates the registry as a side
effect. `main.py` imports `app.services.chunking` at startup (load-bearing — do not
remove). `get_strategy` is the only lookup path; the expander uses it to both
validate a requested name and obtain the instance whose `label()` it calls.

## How the expander fans out a matrix

A run-create request carries a list of **combination specs**, each shaped like
`{strategy, params}`. `params` may optionally contain a `sizes: [...]` list to fan
out one combination per size — a small parameter matrix. `expand` (`expander.py`)
flattens the specs into `ExpandedCombination(strategy, params, label)` cells:

1. **Copy** the params so the caller's dict is never mutated.
2. **Pop `sizes`.** If present, fan out into one param set per size, each setting
   `size = s` (the rest of `base` is shared). If absent, the single `base` set is
   used as-is. Note `sizes` always writes to the `size` key — `recursive` reads
   `size` as an alias for `chunk_size`, so a matrix still works for it.
3. **Validate** the strategy name via `get_strategy`.
4. **Label and de-duplicate.** Compute `label(params)` and skip any cell whose
   label was already emitted. Dedup is **global across all specs** in the request
   and keyed purely on the label string, so two specs resolving to the same label
   collapse to one cell.

Each surviving `ExpandedCombination` becomes a `run_combination` row that the worker
runs through the full pipeline.

## Strategy: sentence

- **`name`**: `sentence`
- **Library**: llama-index `SentenceSplitter`
  (`llama_index.core.node_parser.SentenceSplitter`).
- **What it does**: packs whole sentences toward a token target while keeping
  sentence boundaries intact. Size and overlap are measured in **tokens**.
- **Params** (with aliases / backend defaults):
  - `size` (alias `chunk_size`) — tokens per chunk; backend default `512`.
  - `overlap` — token overlap; backend default `0`.
- **Frontend defaults / bounds** (`strategies.ts`): `size` default `512`
  (min `32`, max `4096`); `overlap` default `20` (min `0`, max `1024`).
- **Label format**: `sentence·{size}/{overlap}` → e.g. `sentence·512/20`.

## Strategy: character

- **`name`**: `character`
- **Library**: none — a deterministic fixed-size character windower written inline.
- **What it does**: slides a window of `size` **characters** across the text with
  `step = max(size - overlap, 1)`, emitting `text[i : i + size]` for each step.
  `size` is floored at `1`. Sizes/overlap are in **characters**.
- **Params** (with aliases / backend defaults):
  - `size` (alias `chunk_size`) — characters per chunk; backend default `1000`.
  - `overlap` — character overlap; backend default `0`.
- **Frontend defaults / bounds**: `size` default `1000` (min `50`, max `8000`);
  `overlap` default `100` (min `0`, max `2000`).
- **Label format**: `character·{size}/{overlap}` → e.g. `character·1000/100`.

## Strategy: recursive

- **`name`**: `recursive`
- **Library**: langchain `RecursiveCharacterTextSplitter`
  (`langchain_text_splitters.RecursiveCharacterTextSplitter`).
- **What it does**: splits using langchain's hierarchical separator list, preferring
  paragraph/line/sentence boundaries before falling back to hard cuts. Sizes are in
  **characters** (langchain's default length function).
- **Params** (with aliases / backend defaults):
  - `chunk_size` (alias `size`) — chunk size; backend default `512`.
  - `overlap` (alias `chunk_overlap`) — overlap; backend default `0`.
- **Frontend defaults / bounds**: `chunk_size` default `512` (min `50`, max `8000`);
  `overlap` default `64` (min `0`, max `2000`).
- **Label format**: `recursive·{chunk_size}/{overlap}` → e.g. `recursive·512/64`.
  Note the label reads the size via `chunk_size` (falling back to the `size` alias).

## Strategy: token

- **`name`**: `token`
- **Library**: the embedding model's own tokenizer via `app.core.embedding.get_tokenizer()`
  (HuggingFace `AutoTokenizer`; tiktoken fallback).
- **What it does**: encodes the text to token ids, slices fixed windows of `size`
  ids with `step = max(size - overlap, 1)`, and decodes each window back to text — so
  chunk size is measured in the **exact tokens the embedding model sees**. For the
  HF tokenizer it encodes with `add_special_tokens=False` and decodes with
  `skip_special_tokens=True`. Decoded pieces are `.strip()`ped and empty pieces
  dropped.
- **Params** (with aliases / backend defaults):
  - `size` (alias `chunk_size`) — tokens per chunk; backend default `256`.
  - `overlap` — token overlap; backend default `0`.
- **Frontend defaults / bounds**: `size` default `256` (min `16`, max `2048`);
  `overlap` default `0` (min `0`, max `512`).
- **Label format**: `token·{size}/{overlap}` → e.g. `token·256/0`.

## Strategy: semantic

- **`name`**: `semantic`
- **Library**: none — a **self-contained** implementation using sentence embeddings
  + numpy (no `langchain-experimental` / `SemanticChunker` dependency). Deterministic.
- **What it does**: splits where the topic shifts. Step by step (`semantic.py`):
  1. **Sentence split** on a regex `(?<=[.!?])\s+` (sentence-ending punctuation
     followed by whitespace); pieces are trimmed and empties dropped. If there is
     ≤ 1 sentence, it returns the sentence(s) (or the whole text) as-is.
  2. **Embed each sentence** with `embed_texts(sentences)`. fastembed returns
     **L2-normalized** vectors, so cosine similarity is just the dot product.
  3. **Consecutive distances**: for adjacent sentences compute
     `sims = sum(e[:-1] * e[1:], axis=1)` and `distances = 1 - sims`. A large
     distance means the topic moved between those two sentences.
  4. **Percentile threshold**: `cutoff = percentile(distances, p)`; any gap whose
     distance **exceeds** the cutoff is a breakpoint. With the default `95`, roughly
     the top 5% largest topic shifts become boundaries — so a higher percentile ⇒
     fewer, larger chunks.
  5. **Assemble**: join the run of sentences between consecutive breakpoints with
     `" "` into one chunk; the trailing run becomes the final chunk; empty results
     are dropped. Because joins use `" "`, the chunk text may not appear verbatim in
     the source, so `assemble` falls back to `(0, 0)` offsets for those chunks
     (expected and harmless for the word-overlap relevance check).
- **Params** (with aliases / backend defaults):
  - `breakpoint_percentile` (alias `threshold`) — backend default `95`. The value is
    normalized: if `≤ 1.0` it is treated as a 0..1 fraction and multiplied by 100
    (so `threshold=0.95` and `breakpoint_percentile=95` behave the same).
- **Frontend defaults / bounds**: `breakpoint_percentile` default `95`
  (min `50`, max `99`).
- **Label format**: `semantic·pct{breakpoint_percentile}` → e.g. `semantic·pct95`.
  The label uses the originally supplied value (falling back to `threshold`, then `95`).

> **Label separator**: every label uses `·` (U+00B7 middle dot), **not** an ASCII
> period. The five formats are exactly: `sentence·{size}/{overlap}`,
> `character·{size}/{overlap}`, `token·{size}/{overlap}`,
> `recursive·{chunk_size}/{overlap}`, `semantic·pct{breakpoint_percentile}`.

## Units differ across strategies

- `sentence` and `token` size in **tokens**.
- `character` and `recursive` size in **characters**.
- `semantic` has no size — it has only a percentile.

`character` and `token` are deterministic windowers using
`step = max(size - overlap, 1)`. The UI param labels (e.g. "Tokens per chunk" vs
"Characters per chunk") reflect these units.

## Backend vs. frontend defaults

The backend defaults are the fallbacks `split()`/`label()` use when a key is missing
from `params`. The frontend defaults in `strategies.ts` are what the UI pre-fills.
The two are **independent** — the frontend merely seeds the form; whatever it sends
is what the backend uses. (This is why a fresh sentence cell from the UI defaults
its overlap to `20`, while the backend's missing-key fallback is `0`.)

## Worked example: sentence vs. character

Take the text:

```
Cats purr. Dogs bark loudly at night.
```

- **`sentence·512/0`** keeps sentence boundaries, so with a large token target both
  sentences pack into one chunk:
  `["Cats purr. Dogs bark loudly at night."]`.
- **`character·12/0`** slides a 12-character window regardless of word/sentence
  boundaries, cutting mid-word:
  `["Cats purr. D", "ogs bark lou", "dly at night", "."]`.

Same text, very different chunk boundaries — which is exactly what chunklab measures.

## Worked example: a matrix expanding to cells

Request body with two specs (one matrix, one single):

```json
{
  "name": "size sweep",
  "combinations": [
    { "strategy": "sentence", "params": { "sizes": [256, 512, 1024], "overlap": 20 } },
    { "strategy": "semantic", "params": { "breakpoint_percentile": 95 } }
  ]
}
```

Expands to **4 cells**:

| Spec | `sizes` fan-out | Resulting `params`            | `label`            |
|------|-----------------|-------------------------------|--------------------|
| 1    | `256`           | `{overlap: 20, size: 256}`    | `sentence·256/20`  |
| 1    | `512`           | `{overlap: 20, size: 512}`    | `sentence·512/20`  |
| 1    | `1024`          | `{overlap: 20, size: 1024}`   | `sentence·1024/20` |
| 2    | (none)          | `{breakpoint_percentile: 95}` | `semantic·pct95`   |

A third spec that resolved to, say, `sentence·512/20` again would be dropped by the
global label dedup, leaving 4 cells.

## Adding a new strategy

Three coordinated edits — one backend class, plus two frontend updates because the
frontend mirrors the label format and the param form.

1. **Backend class**: create `backend/app/services/chunking/<name>.py` with a class
   exposing `name`, `split(self, text, params) -> list[str]`, and
   `label(self, params) -> str`, ending in `register(<Class>())`. Read every value
   through `params.get(key, default)`; drop empty/whitespace-only pieces; make
   `label` deterministic and unique per parameter set (it is the dedup key). If you
   want `sizes`-matrix support, read the chunk size from the `size` key. Add an
   import in `app/services/chunking/__init__.py` so it self-registers at startup
   (otherwise `get_strategy` will reject the name). Add coverage in
   `tests/test_chunking.py`.
2. **Frontend `STRATEGIES` entry** in `strategies.ts`: `id` **must equal** the
   backend `name`, and each param `key` must match a key the backend reads. `default`,
   `min`, `max` seed and bound the UI input.
3. **Frontend `buildLabel` branch**: add a `case` that produces **exactly** the
   string the backend `label()` produces (same `·` separator), or the UI preview and
   client-side dedup will disagree with the server.
