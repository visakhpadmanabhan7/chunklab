# Chunking

chunklab compares chunking strategies head-to-head. Every strategy is a small,
self-registering class behind a common interface; an **expander** turns the
combination specs supplied in a run request into concrete, labeled, de-duplicated
cells; the worker then runs each cell through embed → retrieve → judge → metrics.

This document covers:

- the strategy interface (`split` / `label`) and the registry pattern
- the five built-in strategies (library, parameters, defaults, label format)
- how the semantic chunker works (sentence embeddings + percentile breakpoints)
- how the expander turns specs (with an optional `sizes[]` matrix) into cells
- how to add a new strategy (backend class + register + frontend `strategies.ts`)

All code lives under `backend/app/services/chunking/`.

---

## The strategy interface

A chunking strategy is anything that satisfies the `ChunkingStrategy` protocol
(`base.py`):

```python
@runtime_checkable
class ChunkingStrategy(Protocol):
    name: str

    def split(self, text: str, params: dict) -> list[str]:
        """Split text into raw string pieces."""
        ...

    def label(self, params: dict) -> str:
        """A short human-readable label, e.g. 'sentence·512/20'."""
        ...
```

- **`name`** — the registry key (e.g. `"sentence"`). This is what a run spec's
  `strategy` field references and what the frontend `id` mirrors.
- **`split(text, params)`** — returns the raw chunk strings. It is deliberately
  string-in / string-list-out: no offsets, no token counts, no DB objects. Those
  concerns are layered on afterward by `assemble` and the worker.
- **`label(params)`** — a stable, human-readable identifier for one parameter
  set. Labels are the **dedup key** in the expander and the display key in the
  UI and reports, so the backend `label()` and the frontend `buildLabel()` must
  agree character-for-character.

### `params` is intentionally loose

`params` is a plain `dict`. Each strategy reads what it needs and tolerates
aliases so that a request can use either the "natural" key for that strategy or a
generic one. For example `sentence` accepts `size` **or** `chunk_size`;
`recursive` accepts `chunk_size`/`size` and `overlap`/`chunk_overlap`. This keeps
the run-create API forgiving without forcing a rigid schema per strategy.

### `assemble` — wrapping raw pieces into `Chunk`s

`split` returns bare strings. The worker calls `assemble(text, pieces)` to wrap
each piece into a `Chunk` and recover char offsets against the source document:

```python
@dataclass
class Chunk:
    index: int
    content: str
    start: int = 0  # char offset in the source document (for gold-span overlap)
    end: int = 0
```

`assemble` walks the pieces in order, locating each one with `text.find(piece,
cursor)` and advancing a cursor (the cursor only moves forward by 1 after a hit,
so overlapping chunks still resolve to plausible spans). Empty/whitespace-only
pieces are skipped; pieces that can't be located (e.g. after whitespace
normalization, as the semantic chunker does) fall back to `(0, 0)`. These offsets
are **best-effort** and feed the gold-span overlap relevance check in
`metrics.py` — they are not required to be exact.

---

## The registry pattern

Strategies register themselves at import time (`registry.py`):

```python
STRATEGY_REGISTRY: dict[str, ChunkingStrategy] = {}

def register(strategy: ChunkingStrategy) -> ChunkingStrategy:
    STRATEGY_REGISTRY[strategy.name] = strategy
    return strategy

def get_strategy(name: str) -> ChunkingStrategy:
    if name not in STRATEGY_REGISTRY:
        raise KeyError(
            f"Unknown chunking strategy '{name}'. "
            f"Available: {sorted(STRATEGY_REGISTRY)}"
        )
    return STRATEGY_REGISTRY[name]

def list_strategies() -> list[str]: ...
```

Each strategy module ends with a single line that instantiates the class and
registers the instance:

```python
register(SentenceStrategy())
```

So the registry is populated as a side effect of importing the strategy modules.
`get_strategy` is the only lookup path — the expander calls it both to **validate**
that a requested strategy name exists (it raises a helpful `KeyError` listing the
available names) and to obtain the instance whose `label()` it invokes.

---

## The five built-in strategies

| Strategy    | `name`      | Library / mechanism                                   | Parameters (aliases)                                      | Defaults (backend)            | Frontend defaults    | Label format            | Example label      |
|-------------|-------------|-------------------------------------------------------|----------------------------------------------------------|-------------------------------|----------------------|-------------------------|--------------------|
| Sentence    | `sentence`  | llama-index `SentenceSplitter` (tokens)               | `size` (`chunk_size`), `overlap`                          | `size=512`, `overlap=0`       | `512` / `20`         | `sentence·{size}/{overlap}` | `sentence·512/20`  |
| Character   | `character` | manual fixed-size window + overlap (no library)       | `size` (`chunk_size`), `overlap` (chars)                 | `size=1000`, `overlap=0`      | `1000` / `100`       | `character·{size}/{overlap}`| `character·1000/100` |
| Recursive   | `recursive` | langchain `RecursiveCharacterTextSplitter`            | `chunk_size` (`size`), `overlap` (`chunk_overlap`)       | `chunk_size=512`, `overlap=0` | `512` / `64`         | `recursive·{chunk_size}/{overlap}` | `recursive·512/64` |
| Token       | `token`     | embedding model's own tokenizer (HF; tiktoken fallback)| `size` (`chunk_size`), `overlap` (tokens)               | `size=256`, `overlap=0`       | `256` / `0`          | `token·{size}/{overlap}`    | `token·256/0`      |
| Semantic    | `semantic`  | custom: sentence embeddings + percentile breakpoints  | `breakpoint_percentile` (`threshold`)                    | `breakpoint_percentile=95`    | `95`                 | `semantic·pct{n}`           | `semantic·pct95`   |

Notes:

- **Units differ.** `sentence` and `token` size in **tokens**; `character` sizes
  in **characters**; `recursive` sizes in characters (langchain's default length
  function). Read the parameter labels in the UI accordingly.
- **Backend vs. frontend defaults.** The `Defaults (backend)` column is what
  `label()` / `split()` fall back to when a key is missing in `params`. The
  `Frontend defaults` column is what the UI pre-fills in `strategies.ts` (which
  is why a freshly-added sentence cell from the UI defaults its overlap to `20`,
  not the backend's `0`). The two are independent — the frontend simply seeds the
  form; whatever it sends is what the backend uses.
- **`character` and `token`** are deterministic windowers. They compute
  `step = max(size - overlap, 1)` and slide a window of `size` across the source
  (characters for `character`, decoded token windows for `token`). `token`
  strips and drops empty pieces.
- **`recursive`** uses langchain's hierarchical separator list, so it prefers to
  break on paragraph/line/sentence boundaries before falling back to hard cuts.

---

## How the semantic chunker works

The semantic strategy (`semantic.py`) splits where the topic shifts, using the
same light embedding model as the rest of the system. It is self-contained — no
`langchain-experimental` dependency — and deterministic.

Steps:

1. **Sentence split.** Split the text on sentence-ending punctuation followed by
   whitespace using a regex (`(?<=[.!?])\s+`), trimming and dropping empties. If
   there is ≤ 1 sentence, return it as-is (or the whole text).

2. **Embed each sentence.** `embed_texts(sentences)` returns one vector per
   sentence. fastembed returns **L2-normalized** vectors, so the cosine
   similarity between two sentences is just their dot product.

3. **Consecutive distances.** For adjacent sentences `i` and `i+1`, compute
   `similarity = dot(e[i], e[i+1])` and `distance = 1 - similarity`. A large
   distance means the topic moved between those two sentences.

   ```python
   sims = np.sum(embeddings[:-1] * embeddings[1:], axis=1)
   distances = 1.0 - sims
   ```

4. **Percentile threshold.** Compute the `breakpoint_percentile`-th percentile of
   the distance array as the cutoff. Any gap whose distance **exceeds** the cutoff
   is a breakpoint. With the default `95`, roughly the top 5% largest topic shifts
   become chunk boundaries — so higher percentile ⇒ fewer, larger chunks.

   ```python
   cutoff = float(np.percentile(distances, percentile))
   breakpoints = [i for i, d in enumerate(distances) if d > cutoff]
   ```

5. **Assemble chunks.** Walk the breakpoints, joining the run of sentences
   between consecutive breakpoints (with `" "`) into one chunk; the trailing run
   becomes the final chunk. Empty results are dropped.

**Parameter normalization:** `breakpoint_percentile` is read first, falling back
to `threshold`. If the value is ≤ 1.0 it is treated as a 0..1 fraction and
multiplied by 100 (so `threshold=0.95` and `breakpoint_percentile=95` behave the
same). The label is always `semantic·pct{value}` using the original supplied
value.

Because joins use `" "`, the joined text may not appear verbatim in the source;
`assemble` then falls back to `(0, 0)` offsets for those chunks. That is expected
and harmless for the metrics' word-overlap relevance check.

---

## The expander

A run-create request carries a list of **combination specs**, each shaped like
`{strategy, params}`. `params` may optionally contain a `sizes: [...]` list to
fan out one combination per size — a small parameter matrix. `expand`
(`expander.py`) turns that list of specs into a flat list of concrete cells:

```python
@dataclass
class ExpandedCombination:
    strategy: str
    params: dict
    label: str

def expand(combinations: list[dict]) -> list[ExpandedCombination]:
    out, seen = [], set()
    for spec in combinations:
        strategy = spec["strategy"]
        base = dict(spec.get("params", {}))
        sizes = base.pop("sizes", None)

        param_sets = [{**base, "size": s} for s in sizes] if sizes else [base]

        for params in param_sets:
            strat = get_strategy(strategy)        # validates strategy name
            label = strat.label(params)
            if label in seen:
                continue
            seen.add(label)
            out.append(ExpandedCombination(strategy, params, label))
    return out
```

What it does, step by step:

1. **Copy the params** so the caller's dict is never mutated.
2. **Pop `sizes`.** If present, fan out into one param set per size, each with
   `size = s` (the rest of `base` is shared across all of them). If absent, the
   single `base` param set is used as-is.
3. **Validate** the strategy name via `get_strategy` (raises `KeyError` with the
   available names if unknown).
4. **Label and de-duplicate.** Compute `label(params)` and skip any cell whose
   label was already emitted. Dedup is **global across all specs in the request**
   and keyed purely on the label string — so two specs that resolve to the same
   label (e.g. one `sentence·512/0` written longhand and another produced by a
   `sizes` matrix) collapse to one cell.

> **Note:** `sizes` always fans out into the `size` key. For strategies whose
> natural key is `chunk_size` (recursive), the `size` alias is accepted by both
> `split` and `label`, so a `sizes` matrix still works — the resulting cells use
> `size` in their params and the recursive label reads it via the `size` alias.

Each `ExpandedCombination` becomes a `run_combination` row; the worker then runs
the whole pipeline per cell.

### Worked example

Request body (two specs — one matrix, one single):

```json
{
  "name": "size sweep",
  "combinations": [
    { "strategy": "sentence", "params": { "sizes": [256, 512, 1024], "overlap": 20 } },
    { "strategy": "semantic", "params": { "breakpoint_percentile": 95 } }
  ]
}
```

Expansion:

| Spec | `sizes` fan-out | Resulting `params`              | `label`           |
|------|-----------------|---------------------------------|-------------------|
| 1    | `256`           | `{overlap: 20, size: 256}`      | `sentence·256/20` |
| 1    | `512`           | `{overlap: 20, size: 512}`      | `sentence·512/20` |
| 1    | `1024`          | `{overlap: 20, size: 1024}`     | `sentence·1024/20`|
| 2    | (none)          | `{breakpoint_percentile: 95}`   | `semantic·pct95`  |

→ **4 cells**. If a third spec were added that resolved to, say,
`sentence·512/20` again, it would be dropped by the label dedup, leaving 4.

---

## Adding a new strategy

Three edits — one backend class, one frontend descriptor, and (because they share
the label format) a frontend label branch.

### 1. Backend: write and register the strategy

Create `backend/app/services/chunking/<name>.py`:

```python
"""Paragraph chunking: one chunk per blank-line-delimited block."""

from app.services.chunking.registry import register


class ParagraphStrategy:
    name = "paragraph"

    def split(self, text: str, params: dict) -> list[str]:
        max_blocks = int(params.get("max_blocks", 1))  # blocks per chunk
        blocks = [b.strip() for b in text.split("\n\n") if b.strip()]
        return [
            "\n\n".join(blocks[i : i + max_blocks])
            for i in range(0, len(blocks), max_blocks)
        ]

    def label(self, params: dict) -> str:
        return f"paragraph·{params.get('max_blocks', 1)}"


register(ParagraphStrategy())
```

Guidelines:

- Pick a unique `name`; it is the registry key and the frontend `id`.
- Keep `split` string-in / string-list-out — return raw pieces and let
  `assemble` handle offsets. Drop empty/whitespace-only pieces.
- Read every value through `params.get(..., default)` so missing keys are safe,
  and accept aliases if it helps callers.
- Make `label` deterministic and unique per parameter set — it is the dedup key.
- If you want `sizes`-matrix support, read the chunk size from the `size` key
  (with any natural alias) so the expander's fan-out works.

**Make it import.** The registry is populated by importing the module. Add an
import so it loads at startup — typically alongside the other strategy imports
(e.g. in `app/services/chunking/__init__.py`, or wherever the existing strategy
modules are imported). If the module is never imported, `get_strategy` will not
find it and the expander will reject the name.

### 2. Frontend: add a `strategies.ts` entry

Add a `StrategyDef` to `STRATEGIES` in
`frontend/src/lib/strategies.ts` so the run builder can render the form:

```ts
{
  id: "paragraph",
  label: "Paragraph",
  description: "One chunk per N blank-line-delimited blocks.",
  params: [
    { key: "max_blocks", label: "Blocks per chunk", type: "int", min: 1, max: 20, default: 1 },
  ],
},
```

- `id` **must equal** the backend `name`.
- Each `params` entry's `key` must match a key the backend `split`/`label` reads.
- `default`, `min`, `max` seed and bound the UI input (backend defaults are
  independent — see the table note above).

### 3. Frontend: mirror the label in `buildLabel`

`buildLabel` in `strategies.ts` reproduces the backend `label()` for display and
client-side dedup, so add a matching branch:

```ts
case "paragraph":
  return `paragraph·${params.max_blocks}`;
```

This must produce **exactly** what the backend `label()` produces, otherwise the
UI's preview/dedup will disagree with what the server records.

### Checklist

- [ ] Backend class with `name`, `split`, `label`; ends with `register(...)`.
- [ ] Module is imported at startup so it self-registers.
- [ ] Frontend `STRATEGIES` entry with matching `id` and param `key`s.
- [ ] Frontend `buildLabel` branch matching the backend label byte-for-byte.
- [ ] (Optional) `size`-keyed sizing if you want `sizes`-matrix fan-out.
