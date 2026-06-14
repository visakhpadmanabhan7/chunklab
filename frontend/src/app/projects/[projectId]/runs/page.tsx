"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckSquare, FlaskConical, Plus, Square, Trash2 } from "lucide-react";
import { deleteRun, listRuns } from "@/lib/api";
import { logger } from "@/lib/logger";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Progress } from "@/components/ui/Progress";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";

export default function RunsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data: runs } = useQuery({
    queryKey: ["runs", projectId],
    queryFn: () => listRuns(projectId),
    refetchInterval: (q) =>
      q.state.data?.some((r) => ["queued", "running"].includes(r.status)) ? 2000 : false,
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteRun(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runs", projectId] }),
  });
  const bulkDelete = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await deleteRun(id);
    },
    onSuccess: (_d, ids) => {
      logger.warn("run.bulk_delete", { count: ids.length });
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["runs", projectId] });
    },
  });

  const allIds = runs?.map((r) => r.id) ?? [];
  const allSelected = allIds.length > 0 && selected.size === allIds.length;
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  return (
    <div>
      <PageHeader
        title="Runs"
        subtitle="Each run compares a matrix of chunking strategies across your files."
        actions={
          <Link href={`/projects/${projectId}/runs/new`} className="btn-primary">
            <Plus className="h-4 w-4" /> New run
          </Link>
        }
      />

      {runs && runs.length > 0 ? (
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-2.5">
            <button
              onClick={() => setSelected(allSelected ? new Set() : new Set(allIds))}
              className="flex items-center gap-2 text-sm text-slate-600 hover:text-slate-900"
            >
              {allSelected ? <CheckSquare className="h-4 w-4 text-brand-600" /> : <Square className="h-4 w-4 text-slate-400" />}
              {selected.size > 0 ? `${selected.size} selected` : "Select all"}
            </button>
            {selected.size > 0 && (
              <button
                className="btn-danger btn-sm"
                disabled={bulkDelete.isPending}
                onClick={() => {
                  if (confirm(`Delete ${selected.size} run(s)?`)) bulkDelete.mutate([...selected]);
                }}
              >
                {bulkDelete.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />} Delete selected
              </button>
            )}
          </div>

          <div className="divide-y divide-slate-100">
            {runs.map((r) => {
              const isSel = selected.has(r.id);
              return (
                <div key={r.id} className={`flex items-center gap-3 px-5 py-3.5 ${isSel ? "bg-brand-50/40" : ""}`}>
                  <button onClick={() => toggle(r.id)} className="shrink-0">
                    {isSel ? <CheckSquare className="h-4 w-4 text-brand-600" /> : <Square className="h-4 w-4 text-slate-300 hover:text-slate-500" />}
                  </button>
                  <Link href={`/projects/${projectId}/runs/${r.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600"><FlaskConical className="h-5 w-5" /></span>
                    <div className="min-w-0">
                      <p className="truncate font-medium text-slate-800">{r.name}</p>
                      <p className="text-xs text-slate-500">
                        {r.total_combinations} combinations · top-k {r.top_k} · {new Date(r.created_at).toLocaleString()}
                      </p>
                    </div>
                  </Link>
                  <div className="flex items-center gap-3">
                    {["running", "queued"].includes(r.status) && <Progress value={r.progress} className="w-28" />}
                    <Badge status={r.status}>{r.status}</Badge>
                    <button className="text-slate-300 transition hover:text-rose-600" onClick={() => remove.mutate(r.id)} title="Delete run">
                      <Trash2 className="h-4 w-4" />
                    </button>
                    <ArrowRight className="h-4 w-4 text-slate-300" />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <EmptyState
          icon={FlaskConical}
          title="No runs yet"
          description="Create a run to compare sentence, character, recursive, token, and semantic chunking."
          action={
            <Link href={`/projects/${projectId}/runs/new`} className="btn-primary">
              <Plus className="h-4 w-4" /> New run
            </Link>
          }
        />
      )}
    </div>
  );
}
