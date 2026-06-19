"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { addProjectQA, deleteProjectQA, listProjectQA } from "@/lib/api";

export function QASetManager({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { data: items = [] } = useQuery({
    queryKey: ["project-qa", projectId],
    queryFn: () => listProjectQA(projectId),
  });
  const [q, setQ] = useState("");
  const [a, setA] = useState("");
  const [gold, setGold] = useState("");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["project-qa", projectId] });
  const add = useMutation({
    mutationFn: () =>
      addProjectQA(projectId, [{ question: q, reference_answer: a, source_chunk_text: gold || null }]),
    onSuccess: () => { setQ(""); setA(""); setGold(""); invalidate(); },
  });
  const del = useMutation({ mutationFn: (id: string) => deleteProjectQA(id), onSuccess: invalidate });

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Your QA set ({items.length})
      </p>
      <div className="mb-2 max-h-40 space-y-1 overflow-auto">
        {items.length === 0 && <p className="text-xs text-slate-400">No saved questions yet.</p>}
        {items.map((it) => (
          <div key={it.id} className="flex items-start gap-2 rounded-lg bg-slate-50 px-2 py-1.5 text-xs">
            <span className="flex-1">
              <span className="font-medium text-slate-700">{it.question}</span>
              <span className="text-slate-400"> → {it.reference_answer}</span>
            </span>
            <button onClick={() => it.id && del.mutate(it.id)} className="text-slate-400 hover:text-rose-600">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
      <div className="grid gap-1.5 sm:grid-cols-2">
        <input className="input py-1 text-sm" placeholder="Question" value={q} onChange={(e) => setQ(e.target.value)} />
        <input className="input py-1 text-sm" placeholder="Reference answer" value={a} onChange={(e) => setA(e.target.value)} />
        <input
          className="input py-1 text-sm sm:col-span-2"
          placeholder="Gold passage (optional — improves computed metrics; defaults to the answer)"
          value={gold}
          onChange={(e) => setGold(e.target.value)}
        />
      </div>
      <button
        className="btn-secondary btn-sm mt-2"
        disabled={!q.trim() || !a.trim() || add.isPending}
        onClick={() => add.mutate()}
      >
        <Plus className="h-3.5 w-3.5" /> Add question
      </button>
    </div>
  );
}
