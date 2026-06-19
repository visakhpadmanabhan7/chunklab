"use client";

import Link from "next/link";
import {
  ArrowRight,
  Boxes,
  Coins,
  Database,
  FileText,
  FlaskConical,
  MessageSquare,
  Search,
  ScrollText,
  ShieldCheck,
  Sparkles,
  SplitSquareHorizontal,
} from "lucide-react";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { Logo } from "@/components/ui/Logo";

const STRATEGIES = [
  ["Sentence", "Packs whole sentences up to a token target", "size, overlap"],
  ["Character", "Fixed-size character windows", "size, overlap"],
  ["Recursive", "Hierarchical separators avoid mid-sentence cuts", "chunk_size, overlap"],
  ["Token", "Sized by the embedding model's own tokens", "size, overlap"],
  ["Semantic", "New chunk where the topic shifts (embedding similarity)", "breakpoint_percentile"],
];

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {/* hero */}
      <div className="card overflow-hidden">
        <div className="bg-gradient-to-r from-brand-500 to-sky-500 px-7 py-8 text-white">
          <div className="mb-3">
            <Logo size="lg" onDark />
          </div>
          <p className="max-w-2xl text-sm text-white/90">
            chunklab helps you find the best way to split documents for retrieval-augmented
            generation. Upload documents, define a matrix of chunking strategies, and chunklab
            measures each one on retrieval accuracy, token usage, cost, and latency — so you can
            choose with data instead of guesswork.
          </p>
        </div>
      </div>

      {/* CTA to the dedicated assistant page */}
      <Link href="/assistant" className="card card-hover flex items-center gap-4 p-5">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-sky-500 text-white shadow-sm shadow-brand-600/30">
          <Sparkles className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-slate-800">Ask the docs — product assistant</div>
          <p className="text-sm text-slate-500">
            Chat with an assistant grounded in chunklab&apos;s own documentation (RAG over the docs).
          </p>
        </div>
        <ArrowRight className="h-5 w-5 shrink-0 text-slate-400" />
      </Link>

      <CollapsibleSection icon={FlaskConical} title="How it works" defaultOpen>
        <ol className="list-decimal space-y-1.5 pl-5">
          <li><b>Create a project</b> and upload documents (PDF, Markdown, text, DOCX, PPTX, HTML).</li>
          <li>Each file is <b>parsed</b> (docling, or a fast text parser) into clean text; the original is then discarded.</li>
          <li>Pick a <b>matrix of chunking strategies</b> (strategy × parameters) and launch a run.</li>
          <li>For every combination: chunk → count tokens → embed → store vectors in pgvector.</li>
          <li>Groq auto-generates a <b>QA evaluation set</b>; each combination retrieves top-k and is scored.</li>
          <li>Compare results in <b>analytics</b>, inspect the <b>QA set</b>, and ask the <b>chatbot</b>.</li>
        </ol>
      </CollapsibleSection>

      <CollapsibleSection icon={Boxes} title="Architecture">
        <p>
          A <b>Next.js</b> frontend talks to a <b>FastAPI</b> backend. Heavy work (parsing, embedding,
          dozens of LLM calls) runs in a Redis-backed <b>arq worker</b>, with live progress streamed
          back over SSE. Everything is stored in <b>Postgres + pgvector</b>; embeddings use the local
          <b> FastEmbed bge-small</b> model (384-d), and <b>Groq</b> (llama-3.3-70b) powers QA
          generation, the LLM judge, and the chatbot.
        </p>
      </CollapsibleSection>

      <CollapsibleSection icon={SplitSquareHorizontal} title="Chunking strategies">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr><th>Strategy</th><th>What it does</th><th>Parameters</th></tr>
            </thead>
            <tbody>
              {STRATEGIES.map(([n, d, p]) => (
                <tr key={n}>
                  <td className="font-medium text-slate-700">{n}</td>
                  <td>{d}</td>
                  <td className="font-mono text-xs text-slate-500">{p}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>A run expands your matrix into one labelled, de-duplicated combination per cell.</p>
      </CollapsibleSection>

      {/* the deep dive: retriever + QA + scoring */}
      <CollapsibleSection icon={Search} title="How retrieval & evaluation work">
        <p>
          To compare strategies fairly, chunklab builds <b>one shared QA set</b> from your documents,
          then makes every combination answer the <i>same</i> questions against the <i>same</i>
          documents. Differences in score are attributable to the chunking strategy itself.
        </p>

        <h3 className="pt-1 font-semibold text-slate-700">1 · How the questions are formed</h3>
        <p>
          chunklab samples evenly-spaced ~900-character passages across each parsed document, and for
          each passage Groq writes <b>one grounded question + reference answer</b> (strict JSON). The
          source passage is kept as the <b>gold span</b> — the ground truth used to score retrieval.
          Defaults: <span className="font-mono text-xs">8</span> per file, capped at{" "}
          <span className="font-mono text-xs">10</span> per run; generated once and reused for every
          combination. You can also supply your own ground-truth QA (auto / mine / both).
        </p>

        <h3 className="pt-1 font-semibold text-slate-700">2 · What retrieves the question</h3>
        <p>
          The question is embedded with the same <b>bge-small</b> model (384-d, local), then the
          retriever runs a <b>pgvector cosine nearest-neighbour</b> search scoped to that one
          combination&apos;s chunks:
        </p>
        <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
{`SELECT id, content, embedding <=> :q AS distance
FROM results.chunks
WHERE combination_id = :cid
ORDER BY distance      -- nearest first
LIMIT :k;              -- k = top_k (default 5)`}
        </pre>
        <p>
          Each hit&apos;s relevance is <span className="font-mono text-xs">1 − cosine_distance</span>.
          An HNSW index keeps it fast. Filtering by <span className="font-mono text-xs">combination_id</span>{" "}
          is what keeps the comparison fair — each combination is only searched against its own chunks.
        </p>

        <h3 className="pt-1 font-semibold text-slate-700">3 · How the retrieval is scored</h3>
        <p>Two independent scorers run on the retrieved chunks:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <b>LLM-as-judge</b> (Groq, deterministic) — scores <span className="font-mono text-xs">relevance</span>,{" "}
            <span className="font-mono text-xs">faithfulness</span>,{" "}
            <span className="font-mono text-xs">context_precision</span>,{" "}
            <span className="font-mono text-xs">context_recall</span> (0–1 each) against the reference answer.
          </li>
          <li>
            <b>Computed IR metrics</b> vs the gold passage — <span className="font-mono text-xs">precision@k</span>,{" "}
            <span className="font-mono text-xs">recall@k</span>, <span className="font-mono text-xs">MRR</span>,{" "}
            <span className="font-mono text-xs">nDCG</span>, <span className="font-mono text-xs">F2</span>. A chunk
            counts as relevant when it is from the same file and its word-set overlaps the gold passage ≥ 0.5.
          </li>
        </ul>
        <p>
          Per-question scores are stored (the per-question view) and <b>macro-averaged</b> into one
          metrics row per combination, which drives the analytics dashboard and the analyst chatbot.
        </p>
      </CollapsibleSection>

      <CollapsibleSection icon={FileText} title="Parsing options">
        <p>On the Files page you choose how documents are parsed:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li><b>Docling (rich)</b> — structure-aware, with toggles for <b>OCR</b> (scanned PDFs) and <b>table extraction</b>. Turn these off for much faster PDF parsing.</li>
          <li><b>Fast (text only)</b> — pypdf / plain-text extraction; no models, instant.</li>
        </ul>
      </CollapsibleSection>

      <CollapsibleSection icon={MessageSquare} title="Two chatbots, one pipeline">
        <p>
          The <b>analyst chatbot</b> chats over your experiments — scope it to the whole project, a
          single run, or a comparison of two runs; answers stream from the LLM grounded in stored
          metrics and retrieved chunks. The <b>product assistant</b> (&quot;Ask the docs&quot;) answers
          about chunklab itself, grounded in the documentation. Both use the same retrieve-then-generate
          pipeline and let you bring your own provider/model key per request (kept only in your browser
          session).
        </p>
      </CollapsibleSection>

      <CollapsibleSection icon={Coins} title="Cost model">
        <p>
          Local embeddings are free, so embedding cost is a <b>notional</b> reference rate (configurable)
          that makes combinations dollar-comparable. The Groq judge cost is <b>real</b>, computed from
          token usage. Both are stored per combination.
        </p>
      </CollapsibleSection>

      <CollapsibleSection icon={ShieldCheck} title="Rate limiting & observability">
        <p>
          The API is protected by <b>rate limits</b> (per client IP): a generous global default plus
          stricter caps on chat (30/min), runs (30/min) and uploads (120/min); exceeding a limit returns
          <span className="font-mono text-xs"> HTTP 429</span>. Every request and every UI action is{" "}
          <b>logged</b> at the appropriate level (info / warning / error) to the backend stream for
          easy debugging.
        </p>
      </CollapsibleSection>

      <CollapsibleSection icon={Database} title="Data model">
        <p>
          Two Postgres schemas keep things tidy: <b>core</b> (projects, files, parsed text, runs,
          combinations) and <b>results</b> (chunks + 384-d vectors, QA pairs, retrievals, judge
          evaluations, per-combination stats and metrics, plus the product-assistant doc embeddings).
          Deleting a project cascades through everything.
        </p>
      </CollapsibleSection>

      <CollapsibleSection icon={ScrollText} title="Tech stack">
        <p className="flex flex-wrap gap-2">
          {["FastAPI", "arq worker", "Postgres + pgvector", "Redis", "Next.js 15", "TanStack Query", "Recharts", "FastEmbed bge-small", "Groq llama-3.3-70b", "docling", "slowapi"].map((t) => (
            <span key={t} className="chip">{t}</span>
          ))}
        </p>
        <p className="pt-1 text-xs text-slate-400">
          The product assistant&apos;s knowledge base lives in the repo at{" "}
          <span className="font-mono">backend/app/knowledge/</span>; a self-contained reference for the
          retriever, QA generation and scoring is at{" "}
          <span className="font-mono">docs/retrieval_and_evaluation.html</span>.
        </p>
      </CollapsibleSection>
    </div>
  );
}
