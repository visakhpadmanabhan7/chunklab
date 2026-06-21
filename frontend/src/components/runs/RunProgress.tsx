"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { getCombinations } from "@/lib/api";
import { formatPct } from "@/lib/format";
import { useRunProgress } from "@/hooks/useRunProgress";

const ACTIVE = new Set(["chunking", "embedding", "evaluating", "running"]);

function useElapsed(startedAt: string | null, live: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  if (!startedAt) return null;
  const secs = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function RunProgress({
  runId,
  overallPct,
  startedAt = null,
}: {
  runId: string;
  overallPct: number;
  startedAt?: string | null;
}) {
  const live = useRunProgress(runId, true);
  const { data: combos } = useQuery({
    queryKey: ["combinations", runId],
    queryFn: () => getCombinations(runId),
    refetchInterval: 3000,
  });
  const pct = Math.max(live.runPct || 0, overallPct || 0);
  const elapsed = useElapsed(startedAt, true);

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [live.logs.length]);

  const rows = useMemo(
    () =>
      (combos ?? []).map((c) => {
        const lc = live.combos[c.id];
        return { id: c.id, label: c.label, status: lc?.status || c.status, pct: lc?.pct ?? c.progress };
      }),
    [combos, live.combos],
  );
  const total = rows.length;
  const done = rows.filter((r) => r.status === "completed").length;
  const active = rows.filter((r) => ACTIVE.has(r.status)).length;

  return (
    <div className="space-y-4">
      {/* overall */}
      <div className="card p-5">
        <div className="mb-3 flex items-end justify-between">
          <div className="flex items-center gap-2 text-sm text-slate-500">
            {live.connected && <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />}
            <span>
              {active} running · {done}/{total} done
              {elapsed ? ` · ${elapsed}` : ""}
            </span>
          </div>
          <span className="text-lg font-semibold tabular-nums text-slate-900">{formatPct(pct)}</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-brand-500 transition-all duration-500"
            style={{ width: `${Math.max(pct * 100, 2)}%` }}
          />
        </div>
      </div>

      {/* combinations */}
      <div className="card divide-y divide-slate-100">
        {rows.map((c) => {
          const isDone = c.status === "completed";
          const isActive = ACTIVE.has(c.status);
          return (
            <div key={c.id} className="flex items-center gap-4 px-5 py-3">
              <span className="w-40 shrink-0 truncate font-mono text-[13px] text-slate-600">{c.label}</span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={
                    "h-full rounded-full transition-all duration-500 " +
                    (isDone ? "bg-emerald-400" : "bg-brand-400")
                  }
                  style={{ width: `${Math.max(c.pct * 100, isActive ? 4 : 0)}%` }}
                />
              </div>
              <span
                className={
                  "flex w-24 shrink-0 items-center justify-end gap-1 text-xs " +
                  (isDone ? "text-emerald-600" : isActive ? "text-amber-600" : "text-slate-400")
                }
              >
                {isDone && <Check className="h-3.5 w-3.5" />}
                {c.status || "queued"}
              </span>
            </div>
          );
        })}
        {total === 0 && <div className="px-5 py-6 text-sm text-slate-400">Starting…</div>}
      </div>

      {/* activity (collapsed by default) */}
      {live.logs.length > 0 && (
        <details className="card px-5 py-3">
          <summary className="cursor-pointer select-none text-xs font-medium uppercase tracking-wider text-slate-400">
            Activity
          </summary>
          <div ref={logRef} className="mt-2 max-h-44 space-y-0.5 overflow-auto font-mono text-xs">
            {live.logs.map((l) => (
              <div
                key={l.key}
                className={
                  l.level === "error"
                    ? "text-rose-500"
                    : l.level === "warning"
                      ? "text-amber-600"
                      : "text-slate-400"
                }
              >
                {l.message.length > 160 ? l.message.slice(0, 160) + "…" : l.message}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
