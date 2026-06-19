# What is chunklab?

chunklab is a full-stack tool for **evaluating and comparing text-chunking
strategies for RAG** (retrieval-augmented generation). Instead of guessing how to
split your documents before embedding them, you run a controlled experiment and
choose the chunking strategy with data.

## The problem it solves

In RAG, documents are split into chunks, embedded, and stored in a vector
database; at query time the most similar chunks are retrieved and fed to an LLM.
**How you chunk** (strategy + size + overlap) strongly affects retrieval
accuracy, token usage, cost, and latency — but teams usually pick a chunking
config by guesswork. chunklab turns that into a measured comparison.

## What you do (the workflow)

1. Create a **project** and upload documents (PDF, Markdown, text, DOCX, PPTX, HTML).
2. Each file is **parsed** into clean text (docling, or a fast text parser); the
   original is then discarded.
3. Define a **matrix of chunking strategies** (strategy × parameters). Each cell
   of the matrix is one "combination".
4. Launch a **run**. For every combination, each file is chunked → token-counted →
   embedded → stored as vectors in pgvector.
5. chunklab auto-generates a shared **QA evaluation set** from your documents and
   scores each combination's retrieval with an **LLM-as-judge** plus computed IR
   metrics.
6. Explore **analytics** (accuracy vs cost vs latency), inspect the **QA set**,
   and ask the **chatbot**.

## The core idea

Every combination is evaluated on the *same* questions against the *same*
documents, so differences in the scores are attributable to the chunking strategy
itself. You get a per-combination scoreboard — retrieval-accuracy metrics, token
counts, dollar cost, and latency — enough to pick the best trade-off.

## What a "combination" is

A combination = a chunking strategy plus its parameters, e.g. `sentence·512/20`
(sentence strategy, 512-token target, 20-token overlap) or `recursive·512/64`. A
run expands your chosen matrix into one labelled, de-duplicated combination per
cell and evaluates them all.

## Who it's for

Engineers building RAG systems who want to choose a chunking strategy empirically,
and anyone wanting to understand how chunking choices change retrieval quality and
cost.
