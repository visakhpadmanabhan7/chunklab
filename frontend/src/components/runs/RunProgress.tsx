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
      <div className="card overflow-hidden">
        <div className="bg-gradient-to-r from-brand-500 to-sky-500 px-5 py-4 text-white">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold">Processing experiment</span>
            <span className="flex items-center gap-2 text-sm">
              {live.connected && (
                <span className="flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-xs">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" /> live
                </span>
              )}
              {formatPct(pct)}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-white/25">
            <div className="h-full rounded-full bg-white transition-all duration-500" style={{ width: `${pct * 100}%` }} />
          </div>
        </div>
      </div>

      <div className="card divide-y divide-slate-100">
        {combos?.map((c) => {
          const liveCombo = live.combos[c.id];
          const status = liveCombo?.status || c.status;
          const cpct = liveCombo?.pct ?? c.progress;
          return (
            <div key={c.id} className="flex items-center gap-4 px-5 py-3.5">
              <span className="w-44 truncate font-mono text-sm text-slate-700">{c.label}</span>
              <Progress value={cpct} className="flex-1" />
              <Badge status={status}>{status}</Badge>
            </div>
          );
        })}
      </div>

      {live.logs.length > 0 && (
        <div className="card p-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Activity</p>
          <div className="max-h-44 space-y-0.5 overflow-auto font-mono text-xs text-slate-500">
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
