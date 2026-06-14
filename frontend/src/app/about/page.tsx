import {
  Boxes,
  Coins,
  Database,
  FileText,
  FlaskConical,
  Gauge,
  MessageSquare,
  ScrollText,
  ShieldCheck,
  SplitSquareHorizontal,
} from "lucide-react";

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card p-6">
      <h2 className="mb-3 flex items-center gap-2.5 text-lg font-semibold text-slate-800">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
          <Icon className="h-4 w-4" />
        </span>
        {title}
      </h2>
      <div className="space-y-3 text-sm leading-relaxed text-slate-600">{children}</div>
    </section>
  );
}

const STRATEGIES = [
  ["Sentence", "Packs whole sentences up to a token target", "size, overlap"],
  ["Character", "Fixed-size character windows", "size, overlap"],
  ["Recursive", "Hierarchical separators avoid mid-sentence cuts", "chunk_size, overlap"],
  ["Token", "Sized by the embedding model's own tokens", "size, overlap"],
  ["Semantic", "New chunk where the topic shifts (embedding similarity)", "breakpoint_percentile"],
];

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      {/* hero */}
      <div className="card overflow-hidden">
        <div className="bg-gradient-to-r from-brand-500 to-sky-500 px-7 py-8 text-white">
          <div className="mb-2 flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/20">
              <FlaskConical className="h-6 w-6" />
            </span>
            <div>
              <h1 className="text-2xl font-bold">chunklab</h1>
              <p className="text-sm text-white/80">RAG chunking benchmark</p>
            </div>
          </div>
          <p className="max-w-2xl text-sm text-white/90">
            chunklab helps you find the best way to split documents for retrieval-augmented
            generation. Upload documents, define a matrix of chunking strategies, and chunklab
            measures each one on retrieval accuracy, token usage, cost, and latency — so you can
            choose with data instead of guesswork.
          </p>
        </div>
      </div>

      <Section icon={FlaskConical} title="How it works">
        <ol className="list-decimal space-y-1.5 pl-5">
          <li><b>Create a project</b> and upload documents (PDF, Markdown, text, DOCX, PPTX, HTML).</li>
          <li>Each file is <b>parsed</b> (docling, or a fast text parser) into clean text; the original is then discarded.</li>
          <li>Pick a <b>matrix of chunking strategies</b> (strategy × parameters) and launch a run.</li>
          <li>For every combination: chunk → count tokens → embed → store vectors in pgvector.</li>
          <li>Groq auto-generates a <b>QA evaluation set</b>; each combination retrieves top-k and is scored.</li>
          <li>Compare results in <b>analytics</b>, inspect the <b>QA set</b>, and ask the <b>chatbot</b>.</li>
        </ol>
      </Section>

      <Section icon={Boxes} title="Architecture">
        <p>
          A <b>Next.js</b> frontend talks to a <b>FastAPI</b> backend. Heavy work (parsing, embedding,
          dozens of LLM calls) runs in a Redis-backed <b>arq worker</b>, with live progress streamed
          back over SSE. Everything is stored in <b>Postgres + pgvector</b>; embeddings use the local
          <b> FastEmbed bge-small</b> model (384-d), and <b>Groq</b> (llama-3.3-70b) powers QA
          generation, the LLM judge, and the chatbot.
        </p>
      </Section>

      <Section icon={SplitSquareHorizontal} title="Chunking strategies">
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
      </Section>

      <Section icon={Gauge} title="Evaluation metrics">
        <p>
          <b>LLM-as-judge</b> (Groq, deterministic) scores each retrieval 0–1 on{" "}
          <span className="font-mono text-xs">relevance</span>,{" "}
          <span className="font-mono text-xs">faithfulness</span>,{" "}
          <span className="font-mono text-xs">context_precision</span>, and{" "}
          <span className="font-mono text-xs">context_recall</span>.
        </p>
        <p>
          <b>Computed IR metrics</b> use the gold passage each question was generated from:{" "}
          <span className="font-mono text-xs">precision@k</span>,{" "}
          <span className="font-mono text-xs">recall@k</span>,{" "}
          <span className="font-mono text-xs">MRR</span>,{" "}
          <span className="font-mono text-xs">nDCG</span>, and{" "}
          <span className="font-mono text-xs">F2</span>, macro-averaged per combination.
        </p>
      </Section>

      <Section icon={FileText} title="Parsing options">
        <p>
          On the Files page you choose how documents are parsed:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li><b>Docling (rich)</b> — structure-aware, with toggles for <b>OCR</b> (scanned PDFs) and <b>table extraction</b>. Turn these off for much faster PDF parsing.</li>
          <li><b>Fast (text only)</b> — pypdf / plain-text extraction; no models, instant.</li>
        </ul>
      </Section>

      <Section icon={MessageSquare} title="Chatbot">
        <p>
          Chat with your experiments grounded in their results — scope it to the{" "}
          <b>whole project</b>, a <b>single run</b>, or a <b>comparison of two runs</b>. Answers stream
          from Groq using the stored metrics and retrieved chunks as context.
        </p>
      </Section>

      <Section icon={Coins} title="Cost model">
        <p>
          Local embeddings are free, so embedding cost is a <b>notional</b> reference rate (configurable)
          that makes combinations dollar-comparable. The Groq judge cost is <b>real</b>, computed from
          token usage. Both are stored per combination.
        </p>
      </Section>

      <Section icon={ShieldCheck} title="Rate limiting & observability">
        <p>
          The API is protected by <b>rate limits</b> (per client IP): a generous global default plus
          stricter caps on chat (30/min), runs (30/min) and uploads (120/min); exceeding a limit returns
          <span className="font-mono text-xs"> HTTP 429</span>. Every request and every UI action is{" "}
          <b>logged</b> at the appropriate level (info / warning / error) to the backend stream for
          easy debugging.
        </p>
      </Section>

      <Section icon={Database} title="Data model">
        <p>
          Two Postgres schemas keep things tidy: <b>core</b> (projects, files, parsed text, runs,
          combinations) and <b>results</b> (chunks + 384-d vectors, QA pairs, retrievals, judge
          evaluations, per-combination stats and metrics). Deleting a project cascades through
          everything.
        </p>
      </Section>

      <Section icon={ScrollText} title="Tech stack">
        <p className="flex flex-wrap gap-2">
          {["FastAPI", "arq worker", "Postgres + pgvector", "Redis", "Next.js 15", "TanStack Query", "Recharts", "FastEmbed bge-small", "Groq llama-3.3-70b", "docling", "slowapi"].map((t) => (
            <span key={t} className="chip">{t}</span>
          ))}
        </p>
        <p className="pt-1 text-xs text-slate-400">
          A full, self-contained reference (schema diagrams, API, formulas) lives in the repo at{" "}
          <span className="font-mono">docs/overview.html</span>.
        </p>
      </Section>
    </div>
  );
}
