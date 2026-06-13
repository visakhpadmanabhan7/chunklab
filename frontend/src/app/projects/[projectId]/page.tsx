"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, FileText, Plus } from "lucide-react";
import { listFiles, listRuns } from "@/lib/api";
import { Badge } from "@/components/ui/Badge";
import { Progress } from "@/components/ui/Progress";

export default function OverviewPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: files } = useQuery({ queryKey: ["files", projectId], queryFn: () => listFiles(projectId) });
  const { data: runs } = useQuery({ queryKey: ["runs", projectId], queryFn: () => listRuns(projectId) });

  const parsed = files?.filter((f) => f.status === "parsed").length ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Overview</h1>
        <Link href={`/projects/${projectId}/runs/new`} className="btn-primary">
          <Plus className="h-4 w-4" /> New run
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="card p-5">
          <p className="text-xs uppercase text-slate-400">Files</p>
          <p className="mt-1 text-2xl font-bold">{files?.length ?? 0}</p>
          <p className="text-xs text-slate-500">{parsed} parsed</p>
        </div>
        <div className="card p-5">
          <p className="text-xs uppercase text-slate-400">Runs</p>
          <p className="mt-1 text-2xl font-bold">{runs?.length ?? 0}</p>
        </div>
        <Link href={`/projects/${projectId}/files`} className="card flex flex-col justify-center p-5 hover:shadow-md">
          <p className="flex items-center gap-2 text-sm font-medium text-brand-700">
            <FileText className="h-4 w-4" /> Manage files <ArrowRight className="h-4 w-4" />
          </p>
        </Link>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Recent runs</h2>
        <div className="space-y-2">
          {runs?.slice(0, 6).map((r) => (
            <Link
              key={r.id}
              href={`/projects/${projectId}/runs/${r.id}`}
              className="card flex items-center justify-between p-4 hover:shadow-md"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{r.name}</p>
                <p className="text-xs text-slate-500">{r.total_combinations} combinations</p>
              </div>
              <div className="flex items-center gap-3">
                {r.status === "running" && <Progress value={r.progress} className="w-24" />}
                <Badge status={r.status}>{r.status}</Badge>
              </div>
            </Link>
          ))}
          {runs?.length === 0 && (
            <p className="py-6 text-center text-sm text-slate-400">No runs yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
