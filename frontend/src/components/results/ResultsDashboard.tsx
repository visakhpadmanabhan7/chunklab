"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Award, Coins, Download, Gauge, Trophy } from "lucide-react";
import { getResults, getPerQuestion } from "@/lib/api";
import { formatCost, formatMs, formatTokens } from "@/lib/format";
import type { ReportRow } from "@/lib/types";
import { StatCard } from "@/components/ui/StatCard";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { MetricsInfo } from "@/components/results/MetricsInfo";

const METRIC_COLS: { key: keyof ReportRow; label: string }[] = [
  { key: "relevance", label: "relev" },
  { key: "faithfulness", label: "faith" },
  { key: "precision_at_k", label: "P@k" },
  { key: "recall_at_k", label: "recall" },
  { key: "mrr", label: "mrr" },
  { key: "ndcg_at_k", label: "ndcg" },
  { key: "f2", label: "f2" },
];

const SCATTER_COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6", "#14b8a6", "#ef4444"];
// One stable color per combination (by row order), reused in the scatter + the table.
const comboColor = (i: number) => SCATTER_COLORS[i % SCATTER_COLORS.length];

// Y-axis options for the cost-vs-X scatter (all 0..1, higher = better).
const Y_METRICS = [
  { key: "ndcg_at_k", label: "nDCG" },
  { key: "recall_at_k", label: "recall@k" },
  { key: "precision_at_k", label: "P@k" },
  { key: "mrr", label: "MRR" },
  { key: "f2", label: "F2" },
  { key: "relevance", label: "relevance" },
  { key: "faithfulness", label: "faithfulness" },
  { key: "context_precision", label: "ctx precision" },
  { key: "context_recall", label: "ctx recall" },
] as const;
type YKey = (typeof Y_METRICS)[number]["key"];

function ScatterTip({
  active,
  payload,
  metricLabel = "nDCG",
}: {
  active?: boolean;
  payload?: { payload: { label: string; x: number; y: number; z: number; optimal: boolean } }[];
  metricLabel?: string;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs shadow-sm">
      <p className="font-mono font-semibold text-slate-700">{d.label}{d.optimal ? " ★" : ""}</p>
      <p className="text-slate-500">{metricLabel} <b className="text-slate-700">{d.y.toFixed(3)}</b></p>
      <p className="text-slate-500">cost <b className="text-slate-700">{formatCost(d.x)}</b></p>
      <p className="text-slate-500">latency <b className="text-slate-700">{formatMs(d.z)}</b></p>
    </div>
  );
}

export function ResultsDashboard({ runId }: { runId: string }) {
  const { data, isLoading } = useQuery({ queryKey: ["results", runId], queryFn: () => getResults(runId) });
  const [yKey, setYKey] = useState<YKey>("ndcg_at_k");
  const [view, setView] = useState<"aggregated" | "per-question">("aggregated");
  const [shown, setShown] = useState<string[]>(() => METRIC_COLS.map((c) => c.key as string));
  const { data: pq = [] } = useQuery({
    queryKey: ["per-question", runId],
    queryFn: () => getPerQuestion(runId),
    enabled: view === "per-question",
  });

  if (isLoading) return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[0,1,2,3].map((i) => <CardSkeleton key={i} />)}</div>;
  const rows = data?.combinations ?? [];
  if (rows.length === 0) return <p className="py-8 text-center text-sm text-slate-400">No results.</p>;

  const best = (sel: (r: ReportRow) => number, dir: "max" | "min" = "max") =>
    rows.reduce((a, b) => ((dir === "max" ? sel(b) > sel(a) : sel(b) < sel(a)) ? b : a));

  const bestNdcg = best((r) => r.ndcg_at_k);
  const costRows = rows.filter((r) => r.total_cost_usd > 0);
  const lowestCost = (costRows.length ? costRows : rows).reduce((a, b) => (b.total_cost_usd < a.total_cost_usd ? b : a));
  const fastest = best((r) => r.avg_retrieval_latency_ms || Infinity, "min");
  const bestValue = best((r) => (r.total_cost_usd > 0 ? r.ndcg_at_k / r.total_cost_usd : r.ndcg_at_k));

  // best value per metric column (for highlighting)
  const colMax: Record<string, number> = {};
  METRIC_COLS.forEach((c) => (colMax[c.key as string] = Math.max(...rows.map((r) => r[c.key] as number))));

  const barData = rows.map((r) => ({ label: r.label, relev: r.relevance, faith: r.faithfulness, "P@k": r.precision_at_k, ndcg: r.ndcg_at_k }));
  const yLabel = Y_METRICS.find((m) => m.key === yKey)!.label;
  const scatterData = rows.map((r, i) => {
    const y = r[yKey] as number;
    return {
      x: r.total_cost_usd,
      y,
      z: r.avg_retrieval_latency_ms,
      label: r.label,
      color: comboColor(i),
      // Pareto-optimal: nothing else is both cheaper-or-equal AND as-or-better on the selected metric
      optimal: !rows.some(
        (o) =>
          o !== r &&
          o.total_cost_usd <= r.total_cost_usd &&
          (o[yKey] as number) >= y &&
          (o.total_cost_usd < r.total_cost_usd || (o[yKey] as number) > y),
      ),
    };
  });
  const allZero = rows.every((r) => r.ndcg_at_k === 0 && r.relevance === 0);
  const shownCols = METRIC_COLS.filter((c) => shown.includes(c.key as string));
  const toggleMetric = (k: string) =>
    setShown((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  function exportCsv() {
    const cols =
      view === "per-question"
        ? ["label", "question", ...shown]
        : ["label", "strategy", "chunk_count", "total_tokens", "total_cost_usd", "avg_retrieval_latency_ms", ...shown];
    const data = (view === "per-question" ? pq : rows) as unknown as Record<string, unknown>[];
    const csv = [cols.join(","), ...data.map((r) => cols.map((c) => JSON.stringify(r[c] ?? "")).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = view === "per-question" ? "chunklab-per-question.csv" : "chunklab-results.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      {allZero && (
        <div className="card border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          Accuracy metrics are all zero — this usually means the Groq judge couldn't run (check the API key).
          Token counts and cost below are still valid.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Best nDCG" value={bestNdcg.label} sub={bestNdcg.ndcg_at_k.toFixed(3)} icon={Trophy} accent="brand" />
        <StatCard label="Lowest cost" value={lowestCost.label} sub={`${formatCost(lowestCost.total_cost_usd)} / run`} icon={Coins} accent="emerald" />
        <StatCard label="Fastest retrieval" value={fastest.label} sub={formatMs(fastest.avg_retrieval_latency_ms)} icon={Gauge} accent="sky" />
        <StatCard label="Best accuracy / $" value={bestValue.label} sub={bestValue.ndcg_at_k.toFixed(3)} icon={Award} accent="amber" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="card p-5">
          <h3 className="mb-4 text-sm font-semibold text-slate-700">Accuracy by combination</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={barData} margin={{ left: -18 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={0} angle={-18} textAnchor="end" height={64} />
              <YAxis domain={[0, 1]} tick={{ fontSize: 11 }} />
              <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="ndcg" fill="#6366f1" radius={[4, 4, 0, 0]} />
              <Bar dataKey="P@k" fill="#0ea5e9" radius={[4, 4, 0, 0]} />
              <Bar dataKey="faith" fill="#10b981" radius={[4, 4, 0, 0]} />
              <Bar dataKey="relev" fill="#f59e0b" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card p-5">
          <div className="mb-4 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-700">Cost vs {yLabel} <span className="font-normal text-slate-400">(top-left = better · ★ best)</span></h3>
            <select
              value={yKey}
              onChange={(e) => setYKey(e.target.value as YKey)}
              className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 outline-none focus:border-brand-300"
              title="Choose the y-axis metric"
            >
              {Y_METRICS.map((m) => (
                <option key={m.key} value={m.key}>cost vs {m.label}</option>
              ))}
            </select>
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <ScatterChart margin={{ top: 12, right: 22, bottom: 26, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
              <XAxis
                type="number"
                dataKey="x"
                name="cost"
                tick={{ fontSize: 11 }}
                tickFormatter={(v) => `$${Number(v).toFixed(4)}`}
                label={{ value: "cost ($ / run)", position: "insideBottom", offset: -12, fontSize: 11, fill: "#64748b" }}
              />
              <YAxis
                type="number"
                dataKey="y"
                name={yLabel}
                domain={[0, 1]}
                tick={{ fontSize: 11 }}
                label={{ value: yLabel, angle: -90, position: "insideLeft", offset: 18, fontSize: 11, fill: "#64748b" }}
              />
              <Tooltip cursor={{ strokeDasharray: "3 3" }} content={<ScatterTip metricLabel={yLabel} />} />
              <Legend
                verticalAlign="bottom"
                iconType="circle"
                wrapperStyle={{ fontSize: 11, paddingTop: 10 }}
                payload={scatterData.map((d) => ({
                  value: d.optimal ? `${d.label} ★` : d.label,
                  id: d.label,
                  type: "circle" as const,
                  color: d.optimal ? d.color : "#cbd5e1",
                }))}
              />
              <Scatter data={scatterData}>
                {scatterData.map((d, i) => (
                  <Cell
                    key={i}
                    fill={d.optimal ? d.color : "#cbd5e1"}
                    fillOpacity={d.optimal ? 0.92 : 0.55}
                    stroke={d.optimal ? d.color : "#94a3b8"}
                    strokeWidth={d.optimal ? 2 : 1}
                  />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-700">Results</h3>
            <div className="flex rounded-lg border border-slate-200 p-0.5 text-xs">
              <button
                onClick={() => setView("aggregated")}
                className={view === "aggregated" ? "rounded-md bg-brand-600 px-2.5 py-1 text-white" : "px-2.5 py-1 text-slate-600"}
              >
                Aggregated
              </button>
              <button
                onClick={() => setView("per-question")}
                className={view === "per-question" ? "rounded-md bg-brand-600 px-2.5 py-1 text-white" : "px-2.5 py-1 text-slate-600"}
              >
                Per-question
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <MetricsInfo />
            <button className="btn-secondary btn-sm" onClick={exportCsv}>
              <Download className="h-3.5 w-3.5" /> CSV
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 px-5 pb-3">
          <span className="text-xs text-slate-400">Metrics:</span>
          {METRIC_COLS.map((c) => {
            const on = shown.includes(c.key as string);
            return (
              <button
                key={c.key}
                onClick={() => toggleMetric(c.key as string)}
                className={`rounded-full border px-2 py-0.5 text-xs transition ${
                  on ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-400 hover:text-slate-600"
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>

        <div className="overflow-x-auto">
          {view === "aggregated" ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Combination</th><th>Chunks</th><th>Tokens</th><th>Cost</th><th>Latency</th>
                  {shownCols.map((c) => <th key={c.key}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.combination_id}>
                    <td className="font-mono text-slate-700">
                      <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle" style={{ background: comboColor(i) }} />
                      {r.label}
                    </td>
                    <td>{r.chunk_count}</td>
                    <td>{formatTokens(r.total_tokens)}</td>
                    <td>{formatCost(r.total_cost_usd)}</td>
                    <td>{formatMs(r.avg_retrieval_latency_ms)}</td>
                    {shownCols.map((c) => {
                      const v = r[c.key] as number;
                      const isBest = v > 0 && v === colMax[c.key as string];
                      return (
                        <td key={c.key} className={isBest ? "font-bold text-brand-700" : ""}>
                          {v.toFixed(3)}{isBest && " ★"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Combination</th><th>Question</th>
                  {shownCols.map((c) => <th key={c.key}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {pq.length === 0 ? (
                  <tr><td colSpan={2 + shownCols.length} className="py-6 text-center text-sm text-slate-400">No per-question data for this run.</td></tr>
                ) : (
                  pq.map((r, i) => (
                    <tr key={i}>
                      <td className="whitespace-nowrap font-mono text-slate-700">{r.label}</td>
                      <td className="max-w-md truncate text-slate-600" title={r.question}>{r.question}</td>
                      {shownCols.map((c) => (
                        <td key={c.key}>
                          {Number((r as unknown as Record<string, unknown>)[c.key as string] ?? 0).toFixed(3)}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
