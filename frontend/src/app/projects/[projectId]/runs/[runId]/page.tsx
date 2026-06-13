"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { GitCompare } from "lucide-react";
import { getRun, listRuns } from "@/lib/api";
import { Badge } from "@/components/ui/Badge";
import { RunProgress } from "@/components/runs/RunProgress";
import { ResultsDashboard } from "@/components/results/ResultsDashboard";

export default function RunDetailPage() {
  const { projectId, runId } = useParams<{ projectId: string; runId: string }>();
  const { data: run } = useQuery({
    queryKey: ["run", runId],
    queryFn: () => getRun(runId),
    refetchInterval: (q) =>
      ["queued", "running"].includes(q.state.data?.status ?? "") ? 2000 : false,
  });
  const { data: runs } = useQuery({ queryKey: ["runs", projectId], queryFn: () => listRuns(projectId) });

  if (!run) return null;
  const active = ["queued", "running"].includes(run.status);
  const otherRuns = runs?.filter((r) => r.id !== runId && r.status === "completed") ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{run.name}</h1>
          <p className="text-xs text-slate-500">
            {run.total_combinations} combinations · top-k {run.top_k} · {run.embedding_model}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge status={run.status}>{run.status}</Badge>
          {run.status === "completed" && otherRuns.length > 0 && (
            <select
              className="input w-auto"
              defaultValue=""
              onChange={(e) => {
                if (e.target.value)
                  window.location.href = `/projects/${projectId}/runs/${runId}/compare?with=${e.target.value}`;
              }}
            >
              <option value="">Compare with…</option>
              {otherRuns.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {run.error && (
        <div className="card border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{run.error}</div>
      )}

      {active ? (
        <RunProgress runId={runId} overallPct={run.progress} />
      ) : (
        <>
          <ResultsDashboard runId={runId} />
          {otherRuns.length > 0 && (
            <Link
              href={`/projects/${projectId}/runs/${runId}/compare?with=${otherRuns[0].id}`}
              className="btn-secondary inline-flex"
            >
              <GitCompare className="h-4 w-4" /> Compare runs
            </Link>
          )}
        </>
      )}
    </div>
  );
}
