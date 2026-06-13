"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { listRuns } from "@/lib/api";
import { Badge } from "@/components/ui/Badge";
import { Progress } from "@/components/ui/Progress";

export default function RunsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: runs } = useQuery({
    queryKey: ["runs", projectId],
    queryFn: () => listRuns(projectId),
    refetchInterval: (q) =>
      q.state.data?.some((r) => ["queued", "running"].includes(r.status)) ? 2000 : false,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Runs</h1>
        <Link href={`/projects/${projectId}/runs/new`} className="btn-primary">
          <Plus className="h-4 w-4" /> New run
        </Link>
      </div>

      <div className="space-y-2">
        {runs?.map((r) => (
          <Link
            key={r.id}
            href={`/projects/${projectId}/runs/${r.id}`}
            className="card flex items-center justify-between p-4 hover:shadow-md"
          >
            <div className="min-w-0">
              <p className="truncate font-medium">{r.name}</p>
              <p className="text-xs text-slate-500">
                {r.total_combinations} combinations · top-k {r.top_k} · {new Date(r.created_at).toLocaleString()}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {["running", "queued"].includes(r.status) && <Progress value={r.progress} className="w-28" />}
              <Badge status={r.status}>{r.status}</Badge>
            </div>
          </Link>
        ))}
        {runs?.length === 0 && (
          <p className="py-8 text-center text-sm text-slate-400">
            No runs yet. Create one to compare chunking strategies.
          </p>
        )}
      </div>
    </div>
  );
}
