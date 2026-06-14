# Sample documents

A deliberately varied set of inputs for trying out chunklab. The point is to see
how different chunking strategies behave on different **structures** — flowing
prose vs. lists vs. tables vs. Q&A vs. dense legalese vs. code.

Upload any of these in a project (Files → drag & drop), then launch a run.

> Note: chunklab does **not** keep your uploaded files — each is parsed and the
> original is deleted; only the extracted text is stored. These samples live in
> the repo so you always have inputs to try.

## Standard benchmark documents
The documents people usually compare RAG chunking on (downloaded from their
canonical sources):

| File | Format | Source / what it is |
|------|--------|---------------------|
| `benchmark_attention_is_all_you_need.pdf` | PDF | the Transformer paper (arXiv 1706.03762) — exercises docling PDF parsing |
| `benchmark_paul_graham_essay.txt` | Text | "What I Worked On" — the canonical LlamaIndex RAG demo essay |
| `benchmark_state_of_the_union.txt` | Text | 2022 State of the Union — the classic LangChain demo doc |
| `benchmark_wikipedia_large_language_model.txt` | Text | Wikipedia: Large language model — encyclopedic prose |
| `benchmark_wikipedia_retrieval-augmented_.txt` | Text | Wikipedia: Retrieval-augmented generation |

## Synthetic structure samples
Hand-written to cover formats/structures the benchmarks don't:

| File | Format | Structure | Good for testing |
|------|--------|-----------|------------------|
| `rag_handbook.md` | Markdown | headers, lists, code blocks | recursive vs. sentence on structured docs |
| `faq.md` | Markdown | short Q&A pairs | small chunk sizes; retrieval precision |
| `recipes.md` | Markdown | numbered steps + lists | how overlap affects step continuity |
| `the_lighthouse.txt` | Plain text | long narrative prose | sentence/semantic on flowing text |
| `terms_of_service.txt` | Plain text | numbered legal clauses | character vs. recursive on dense text |
| `product_spec.html` | HTML | headings + a table | docling parsing of structured HTML |
| `quarterly_metrics.csv` | CSV | tabular rows | how chunkers handle tables/rows |

> Tip: add a few combinations (e.g. `character·1000/100`, `recursive·512/64`,
> `sentence·256/20`, `semantic·pct90`) and compare nDCG / cost / tokens.
