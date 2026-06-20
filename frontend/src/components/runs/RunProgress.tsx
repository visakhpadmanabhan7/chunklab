"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, CheckCircle2, Cpu, Layers, Loader2, ScanSearch, Zap } from "lucide-react";
import { getCombinations } from "@/lib/api";
import { formatPct } from "@/lib/format";
import { useRunProgress } from "@/hooks/useRunProgress";
import { Badge } from "@/components/ui/Badge";

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

/** Two-stage stepper: chunk+embed → evaluate → done. */
function StageSteps({ status, pct }: { status: string; pct: number }) {
  const stage = status === "completed" ? 2 : status === "evaluating" ? 1 : 0;
  const steps = [
    { label: "Chunk & embed", icon: Layers },
    { label: "Evaluate", icon: ScanSearch },
  ];
  return (
    <div className="flex items-center gap-1.5">
      {steps.map((st, i) => {
        const done = stage > i || status === "completed";
        const activeStep = stage === i && ACTIVE.has(status);
        return (
          <span
            key={st.label}
            className={
              "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium " +
              (done
                ? "bg-emerald-50 text-emerald-600"
                : activeStep
                  ? "bg-amber-50 text-amber-700"
                  : "bg-slate-50 text-slate-400")
            }
          >
            {done ? (
              <CheckCircle2 className="h-3 w-3" />
            ) : activeStep ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <st.icon className="h-3 w-3" />
            )}
            {st.label}
          </span>
        );
      })}
      <span className="ml-auto font-mono text-[11px] text-slate-400">{formatPct(pct)}</span>
    </div>
  );
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

  const rows = useMemo(() => {
    return (combos ?? []).map((c) => {
      const lc = live.combos[c.id];
      return { id: c.id, label: c.label, status: lc?.status || c.status, pct: lc?.pct ?? c.progress };
    });
  }, [combos, live.combos]);

  const total = rows.length;
  const done = rows.filter((r) => r.status === "completed").length;
  const active = rows.filter((r) => ACTIVE.has(r.status)).length;
  const queued = total - done - active;

  return (
    <div className="space-y-5">
      {/* hero */}
      <div className="card overflow-hidden">
        <div className="relative bg-gradient-to-r from-brand-600 via-brand-500 to-sky-500 px-6 py-5 text-white">
          <div className="mb-3 flex items-start justify-between">
            <div>
              <p className="flex items-center gap-2 text-sm font-semibold">
                <Zap className="h-4 w-4" /> Processing experiment
              </p>
              <p className="mt-0.5 text-xs text-white/75">
                {active} running · {done}/{total} done{queued > 0 ? ` · ${queued} queued` : ""}
                {elapsed ? ` · ${elapsed} elapsed` : ""}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {live.connected && (
                <span className="flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-xs">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" /> live
                </span>
              )}
              <span className="text-2xl font-bold tabular-nums">{formatPct(pct)}</span>
            </div>
          </div>
          <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-white/25">
            <div
              className="progress-stripes h-full rounded-full bg-white/90 transition-all duration-500"
              style={{ width: `${Math.max(pct * 100, 2)}%` }}
            />
          </div>
        </div>

        {/* mini stat strip */}
        <div className="grid grid-cols-3 divide-x divide-slate-100 text-center">
          <Stat icon={Cpu} label="Running" value={active} tone="amber" />
          <Stat icon={CheckCircle2} label="Completed" value={`${done}/${total}`} tone="emerald" />
          <Stat icon={Layers} label="Queued" value={queued} tone="slate" />
        </div>
      </div>

      {/* per-combination cards (run in parallel) */}
      <div className="grid gap-3 sm:grid-cols-2">
        {rows.map((c) => {
          const isActive = ACTIVE.has(c.status);
          return (
            <div
              key={c.id}
              className={
                "card p-4 transition " +
                (isActive ? "ring-1 ring-brand-200" : c.status === "completed" ? "opacity-90" : "")
              }
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="truncate font-mono text-sm font-medium text-slate-700">{c.label}</span>
                <Badge status={c.status}>{c.status || "queued"}</Badge>
              </div>
              <div className="relative mb-2.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className={
                    "h-full rounded-full transition-all duration-500 " +
                    (c.status === "completed" ? "bg-emerald-500" : "bg-brand-500")
                  }
                  style={{ width: `${Math.max(c.pct * 100, isActive ? 4 : 0)}%` }}
                />
                {isActive && <span className="shimmer absolute inset-0" />}
              </div>
              <StageSteps status={c.status} pct={c.pct} />
            </div>
          );
        })}
        {total === 0 &&
          Array.from({ length: 2 }).map((_, i) => <div key={i} className="card h-28 skeleton" />)}
      </div>

      {/* activity feed */}
      {live.logs.length > 0 && (
        <div className="card p-4">
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            <Activity className="h-3.5 w-3.5" /> Activity
          </p>
          <div ref={logRef} className="max-h-52 space-y-0.5 overflow-auto font-mono text-xs">
            {live.logs.map((l) => (
              <div
                key={l.key}
                className={
                  "flex gap-2 " +
                  (l.level === "error"
                    ? "text-rose-600"
                    : l.level === "warning"
                      ? "text-amber-600"
                      : "text-slate-500")
                }
              >
                <span className="select-none text-slate-300">›</span>
                <span className="whitespace-pre-wrap">{l.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Cpu;
  label: string;
  value: React.ReactNode;
  tone: "amber" | "emerald" | "slate";
}) {
  const c = {
    amber: "text-amber-600",
    emerald: "text-emerald-600",
    slate: "text-slate-400",
  }[tone];
  return (
    <div className="px-4 py-3">
      <p className="flex items-center justify-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">
        <Icon className={`h-3.5 w-3.5 ${c}`} /> {label}
      </p>
      <p className="mt-0.5 text-lg font-bold tabular-nums text-slate-800">{value}</p>
    </div>
  );
}
