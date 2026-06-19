# FAQ

**What is chunklab?** A tool to evaluate and compare text-chunking strategies for
RAG. You upload documents, define a matrix of chunking strategies, run an
experiment, and get per-combination accuracy / cost / latency scores. (See
`00_what_is_chunklab.md`.)

**What is a "combination"?** A chunking strategy plus its parameters, e.g.
`sentence·512/20`. A run evaluates one combination per matrix cell.

**Which chunking strategies are supported?** sentence, character, recursive,
token, and semantic. (See `03_chunking_strategies.md`.)

**How are the evaluation questions formed?** chunklab samples evenly-spaced
passages from each parsed document and asks Groq to write one grounded question +
reference answer per passage, keeping the source passage as the gold span.
Defaults: 8 per file, capped at 10 per run. (See
`04_qa_generation_and_evaluation.md`.)

**What retriever do you use?** A pgvector cosine nearest-neighbour search over the
chunk embeddings, scoped per combination, returning top-k (default 5). Embeddings
are local FastEmbed bge-small (384-d). (See `05_retrieval_and_vector_search.md`.)

**What retrieves the question against the chunks?** The question is embedded with
bge-small (`embed_query`), then `retrieve()` runs
`ORDER BY embedding <=> query_vector LIMIT k` filtered to that combination's
chunks; relevance = 1 − cosine distance. (See `05_retrieval_and_vector_search.md`.)

**How is retrieval scored?** Two ways: an LLM-as-judge (relevance, faithfulness,
context_precision, context_recall, each 0–1) and computed IR metrics (precision@k,
recall@k, MRR, nDCG, F2) measured against the gold passage. Both are
macro-averaged per combination. (See `04_qa_generation_and_evaluation.md`.)

**What embedding model?** `BAAI/bge-small-en-v1.5` via FastEmbed — local, free,
384-dimensional, CPU. No embedding API is called.

**What LLM?** Groq `llama-3.3-70b-versatile` by default for QA generation,
judging, and chat. You can bring your own OpenAI / Anthropic / Groq key per chat
request.

**How is cost computed?** Embeddings are local (free), so embedding cost is a
notional reference rate to keep combinations comparable; LLM (judge) cost is real,
from token usage. (See `08_cost_and_pricing.md`.)

**Why two Postgres schemas?** `core` holds inputs / run definitions, `results`
holds experiment outputs (including the `vector(384)` chunk embeddings). (See
`02_data_model.md`.)

**Do you store my files?** Files are parsed into clean text and the original is
discarded; the parsed text + chunks + vectors are stored. Deleting a project
cascades and removes everything.

**Is the product assistant (this chatbot) using RAG?** Yes — it embeds your
question and retrieves the most relevant sections of chunklab's own documentation
from pgvector, then answers from them. It dogfoods the same pipeline chunklab
benchmarks. (See `06_chat_and_product_assistant.md`.)

**How do I run it?** `docker compose up --build` brings up Postgres+pgvector,
Redis, backend, worker, and frontend. (See `09_setup_and_stack.md`.)
