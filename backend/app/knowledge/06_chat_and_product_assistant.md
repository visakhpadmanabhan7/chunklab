# Chatbots & the product assistant

chunklab has a streaming chat backed by `POST /api/v1/chat/stream`. The same
endpoint serves two kinds of assistant, selected by `scope`.

## The analyst assistant (scope: project / run / compare)

Grounds answers in your experiment results.

- **run** — answers about a single run. Context = a precomputed **Leaderboard**
  (best AND weakest per metric + the full nDCG ranking), a **metrics table** of
  every combination, and retrieved chunks from the run's best combination.
- **compare** — two runs side by side.
- **project** — the recent completed runs in a project.

Context is assembled by `app/services/chat/context_builder.py` from the aggregated
`metrics` / `combination_stats` (via `build_run_report`) plus vector-retrieved
snippets. The Leaderboard is precomputed so even smaller models read answers off
it rather than re-deriving them (which avoids hallucinated winners). System
prompt: `CHAT_SYSTEM_PROMPT`.

## The product assistant (scope: about)

This is the chatbot on the **About page** that answers questions about chunklab
itself. It dogfoods chunklab's own RAG pipeline:

1. chunklab's curated docs (the `app/knowledge/*.md` files — including these very
   pages) are split by heading, embedded with bge-small, and stored in
   `results.doc_chunks` (idempotent ingest at startup, keyed by a corpus hash).
2. When you ask a question it is embedded, and the most similar doc sections are
   retrieved by pgvector cosine search (`retrieve_docs` in
   `app/services/docs/knowledge.py`).
3. The retrieved sections (tagged `[source › section]`) plus a short product
   preamble become the context; `CHAT_ABOUT_SYSTEM_PROMPT` instructs the model to
   answer ONLY from that context, be technical, and cite sources.

So the product assistant is itself a small RAG system — the same idea chunklab
benchmarks.

## Streaming & history

Answers stream as `text/plain` tokens (the frontend reads them with `fetch` +
`ReadableStream`, not EventSource). The last 8 turns of history are included.
Temperature is low (0.3) for grounded answers.

## Bring-your-own model (per request)

By default chat uses the server's Groq key and `llama-3.3-70b-versatile`. You can
pick a saved key (OpenAI / Anthropic / Groq) and model in the chat header;
`provider`, `model`, and `api_key` are sent **per request**, used transiently, and
never stored server-side (keys live only in your browser session).

## Limits

Chat is rate-limited to 30 requests/minute per client IP; provider/key errors are
surfaced inline in the stream rather than hanging.
