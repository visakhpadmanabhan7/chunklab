"use client";

import { useState } from "react";
import { Info, X } from "lucide-react";

interface Metric {
  name: string;
  kind: "Computed" | "LLM judge";
  def: string;
  example: string;
}

const METRICS: Metric[] = [
  {
    name: "precision@k",
    kind: "Computed",
    def: "Of the top-k retrieved chunks, the fraction that are actually relevant (overlap the gold passage the question came from).",
    example: "Retrieved 5, 2 relevant → 2 / 5 = 0.40.",
  },
  {
    name: "recall@k",
    kind: "Computed",
    def: "Whether the answer's source was retrieved at all — 1 if any relevant chunk is in the top-k, else 0 (one gold passage per question).",
    example: "Gold passage appears at rank 3 of top-5 → 1.0. Not in top-5 → 0.0.",
  },
  {
    name: "MRR",
    kind: "Computed",
    def: "Mean Reciprocal Rank — 1 / (rank of the first relevant chunk). Rewards putting the right chunk first.",
    example: "First relevant at rank 1 → 1.0; at rank 2 → 0.50; at rank 4 → 0.25.",
  },
  {
    name: "nDCG@k",
    kind: "Computed",
    def: "Normalized Discounted Cumulative Gain — like recall but rewards ranking relevant chunks higher. 1.0 = ideal ordering.",
    example: "Relevant chunk at rank 1 → 1.0; same chunk at rank 3 → ~0.5.",
  },
  {
    name: "F2",
    kind: "Computed",
    def: "Harmonic blend of precision and recall, weighting recall 2× (missing the answer is worse than extra chunks). F2 = 5·P·R / (4·P + R).",
    example: "P = 0.4, R = 1.0 → F2 ≈ 0.77.",
  },
  {
    name: "relevance",
    kind: "LLM judge",
    def: "Are the retrieved chunks on-topic for the question? Scored 0–1 by the LLM judge.",
    example: 'Question about "chunk overlap"; retrieved chunks all discuss overlap → ~1.0.',
  },
  {
    name: "faithfulness",
    kind: "LLM judge",
    def: "Is the reference answer actually supported by (derivable from) the retrieved context? 0–1.",
    example: "Answer claims a fact that appears verbatim in a retrieved chunk → high.",
  },
  {
    name: "context_precision",
    kind: "LLM judge",
    def: "Fraction of the retrieved context the judge considers useful for answering (signal vs. noise).",
    example: "3 of 5 chunks useful → ~0.6.",
  },
  {
    name: "context_recall",
    kind: "LLM judge",
    def: "Does the retrieved context contain everything needed to answer the question? 0–1.",
    example: "Answer needs two facts; both present in context → ~1.0.",
  },
];

export function MetricsInfo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="btn-secondary btn-sm"
        onClick={() => setOpen(true)}
        title="What do these metrics mean?"
      >
        <Info className="h-3.5 w-3.5" /> Metric guide
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="card max-h-[85vh] w-full max-w-2xl overflow-auto p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Retrieval metrics</h2>
                <p className="text-sm text-slate-500">
                  How each combination is scored. Higher is better; all range 0–1.
                </p>
              </div>
              <button className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" onClick={() => setOpen(false)}>
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3">
              {METRICS.map((m) => (
                <div key={m.name} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-brand-700">{m.name}</span>
                    <span
                      className={`badge ${
                        m.kind === "Computed" ? "bg-sky-100 text-sky-700" : "bg-violet-100 text-violet-700"
                      }`}
                    >
                      {m.kind}
                    </span>
                  </div>
                  <p className="mt-1.5 text-sm text-slate-600">{m.def}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    <span className="font-semibold">Example:</span> {m.example}
                  </p>
                </div>
              ))}
            </div>

            <p className="mt-4 text-xs text-slate-400">
              <span className="font-semibold text-sky-700">Computed</span> metrics use the gold passage each
              question was generated from (no LLM). <span className="font-semibold text-violet-700">LLM judge</span>{" "}
              metrics are scored by Groq. The QA set is shared across every combination so scores are comparable.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
