"use client";

import { useQuery } from "@tanstack/react-query";
import { getCombinations } from "@/lib/api";
import { formatPct } from "@/lib/format";
import { useRunProgress } from "@/hooks/useRunProgress";
import { Badge } from "@/components/ui/Badge";
import { Progress } from "@/components/ui/Progress";

export function RunProgress({ runId, overallPct }: { runId: string; overallPct: number }) {
  const live = useRunProgress(runId, true);
  const { data: combos } = useQuery({
    queryKey: ["combinations", runId],
    queryFn: () => getCombinations(runId),
    refetchInterval: 3000,
  });

  const pct = live.runPct || overallPct;

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="font-medium">Overall progress</span>
          <span className="flex items-center gap-2 text-slate-500">
            {live.connected && (
              <span className="flex items-center gap-1 text-emerald-600">
                <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" /> live
              </span>
            )}
            {formatPct(pct)}
          </span>
        </div>
        <Progress value={pct} />
      </div>

      <div className="card divide-y divide-slate-100">
        {combos?.map((c) => {
          const liveCombo = live.combos[c.id];
          const status = liveCombo?.status || c.status;
          const cpct = liveCombo?.pct ?? c.progress;
          return (
            <div key={c.id} className="flex items-center gap-4 px-5 py-3">
              <span className="w-48 truncate font-mono text-sm">{c.label}</span>
              <Progress value={cpct} className="flex-1" />
              <Badge status={status}>{status}</Badge>
            </div>
          );
        })}
      </div>

      {live.logs.length > 0 && (
        <div className="card p-4">
          <p className="mb-2 text-xs font-semibold uppercase text-slate-400">Logs</p>
          <div className="max-h-40 overflow-auto font-mono text-xs text-slate-500">
            {live.logs.map((l) => (
              <div key={l.key} className={l.level === "error" ? "text-rose-600" : ""}>
                {l.message}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
