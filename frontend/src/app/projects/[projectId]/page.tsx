"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, BarChart3, FileText, FlaskConical, Plus, Upload } from "lucide-react";
import { listFiles, listRuns } from "@/lib/api";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { Badge } from "@/components/ui/Badge";
import { Progress } from "@/components/ui/Progress";
import { EmptyState } from "@/components/ui/EmptyState";

export default function OverviewPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: files } = useQuery({ queryKey: ["files", projectId], queryFn: () => listFiles(projectId) });
  const { data: runs } = useQuery({ queryKey: ["runs", projectId], queryFn: () => listRuns(projectId) });

  const parsed = files?.filter((f) => f.status === "parsed").length ?? 0;
  const completed = runs?.filter((r) => r.status === "completed").length ?? 0;

  return (
    <div>
      <PageHeader
        title="Overview"
        subtitle="Snapshot of this project's documents and experiments."
        actions={
          <Link href={`/projects/${projectId}/runs/new`} className="btn-primary">
            <Plus className="h-4 w-4" /> New run
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Files" value={files?.length ?? 0} sub={`${parsed} parsed`} icon={FileText} accent="sky" />
        <StatCard label="Runs" value={runs?.length ?? 0} sub={`${completed} completed`} icon={FlaskConical} accent="brand" />
        <Link href={`/projects/${projectId}/files`} className="card card-hover flex items-center gap-3 p-5">
          <span className="rounded-xl bg-emerald-50 p-2.5 text-emerald-600"><Upload className="h-5 w-5" /></span>
          <div>
            <p className="text-sm font-semibold text-slate-800">Add documents</p>
            <p className="text-xs text-slate-500">Upload files to chunk</p>
          </div>
        </Link>
        <Link href={`/projects/${projectId}/analytics`} className="card card-hover flex items-center gap-3 p-5">
          <span className="rounded-xl bg-amber-50 p-2.5 text-amber-600"><BarChart3 className="h-5 w-5" /></span>
          <div>
            <p className="text-sm font-semibold text-slate-800">Analytics</p>
            <p className="text-xs text-slate-500">Compare all runs</p>
          </div>
        </Link>
      </div>

      <h2 className="mb-3 mt-8 text-sm font-semibold text-slate-700">Recent runs</h2>
      {runs && runs.length > 0 ? (
        <div className="space-y-2">
          {runs.slice(0, 8).map((r) => (
            <Link
              key={r.id}
              href={`/projects/${projectId}/runs/${r.id}`}
              className="card card-hover flex items-center justify-between p-4"
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-800">{r.name}</p>
                <p className="text-xs text-slate-500">
                  {r.total_combinations} combinations · {new Date(r.created_at).toLocaleString()}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {["running", "queued"].includes(r.status) && <Progress value={r.progress} className="w-28" />}
                <Badge status={r.status}>{r.status}</Badge>
                <ArrowRight className="h-4 w-4 text-slate-300" />
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={FlaskConical}
          title="No runs yet"
          description="Add documents, then launch a run to compare chunking strategies."
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
