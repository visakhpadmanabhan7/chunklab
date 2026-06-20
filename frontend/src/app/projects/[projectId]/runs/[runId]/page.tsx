"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BarChart3, FlaskConical, GitCompare, MessageSquare, MessageSquareText, RefreshCw } from "lucide-react";
import { getRun, listRuns, rerunRun } from "@/lib/api";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import { RunProgress } from "@/components/runs/RunProgress";
import { ResultsDashboard } from "@/components/results/ResultsDashboard";
import { QASet } from "@/components/results/QASet";
import { ChatPanel, RUN_SUGGESTIONS } from "@/components/chat/ChatPanel";

export default function RunDetailPage() {
  const { projectId, runId } = useParams<{ projectId: string; runId: string }>();
  const { data: run, isLoading, isError } = useQuery({
    queryKey: ["run", runId],
    queryFn: () => getRun(runId),
    retry: false,
    refetchInterval: (q) => (["queued", "running"].includes(q.state.data?.status ?? "") ? 2000 : false),
  });
  const { data: runs } = useQuery({ queryKey: ["runs", projectId], queryFn: () => listRuns(projectId) });
  const [tab, setTab] = useState<"analytics" | "qa" | "chat">("analytics");
  const router = useRouter();
  const rerun = useMutation({
    mutationFn: () => rerunRun(runId),
    onSuccess: (r) => router.push(`/projects/${projectId}/runs/${r.id}`),
  });

  if (isLoading) return <div className="h-40 skeleton" />;
  if (isError || !run)
    return (
      <EmptyState
        icon={FlaskConical}
        title="Run not found"
        description="This run no longer exists — it may have been deleted or the database was reset."
        action={
          <Link href={`/projects/${projectId}/runs`} className="btn-primary">
            Back to runs
          </Link>
        }
      />
    );
  const active = ["queued", "running"].includes(run.status);
  const otherRuns = runs?.filter((r) => r.id !== runId && r.status === "completed") ?? [];

  return (
    <div>
      <PageHeader
        title={run.name}
        subtitle={`${run.total_combinations} combinations · top-k ${run.top_k} · ${run.embedding_model}`}
        actions={
          <div className="flex items-center gap-2">
            <Badge status={run.status}>{run.status}</Badge>
            {["completed", "failed", "canceled"].includes(run.status) && (
              <button className="btn-secondary" onClick={() => rerun.mutate()} disabled={rerun.isPending}>
                <RefreshCw className="h-4 w-4" /> Re-run
              </button>
            )}
            {run.status === "completed" && otherRuns.length > 0 && (
              <Link
                href={`/projects/${projectId}/runs/${runId}/compare?with=${otherRuns[0].id}`}
                className="btn-secondary"
              >
                <GitCompare className="h-4 w-4" /> Compare
              </Link>
            )}
          </div>
        }
      />

      {run.error && (
        <div className="card mb-4 border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{run.error}</div>
      )}

      {active ? (
        <RunProgress runId={runId} overallPct={run.progress} startedAt={run.started_at} />
      ) : (
        <>
          <div className="mb-5 inline-flex rounded-xl border border-slate-200 bg-white p-1">
            {([
              { id: "analytics", label: "Analytics", icon: BarChart3 },
              { id: "qa", label: "QA set", icon: MessageSquareText },
              { id: "chat", label: "Chat", icon: MessageSquare },
            ] as const).map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={
                  tab === t.id
                    ? "flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-1.5 text-sm font-medium text-white"
                    : "flex items-center gap-2 rounded-lg px-4 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-900"
                }
              >
                <t.icon className="h-4 w-4" />
                {t.label}
              </button>
            ))}
          </div>
          {tab === "analytics" && <ResultsDashboard runId={runId} />}
          {tab === "qa" && <QASet runId={runId} projectId={projectId} />}
          {tab === "chat" && (
            <ChatPanel
              projectId={projectId}
              scope="run"
              runId={runId}
              heightClass="h-[560px]"
              suggestions={RUN_SUGGESTIONS}
              placeholder="Ask about this run…"
            />
          )}
        </>
      )}
    </div>
  );
}
