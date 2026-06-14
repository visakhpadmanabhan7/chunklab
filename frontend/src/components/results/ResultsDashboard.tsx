"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { Award, Coins, Download, Gauge, Trophy } from "lucide-react";
import { getResults } from "@/lib/api";
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

function downloadCsv(rows: ReportRow[]) {
  const cols = [
    "label", "strategy", "chunk_count", "total_tokens", "total_cost_usd", "avg_retrieval_latency_ms",
    "relevance", "faithfulness", "context_precision", "context_recall",
    "precision_at_k", "recall_at_k", "mrr", "ndcg_at_k", "f2",
  ];
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => (r as any)[c]).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "chunklab-results.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export function ResultsDashboard({ runId }: { runId: string }) {
  const { data, isLoading } = useQuery({ queryKey: ["results", runId], queryFn: () => getResults(runId) });

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
  const scatterData = rows.map((r) => ({ x: r.total_cost_usd, y: r.ndcg_at_k, z: r.avg_retrieval_latency_ms, label: r.label }));
  const allZero = rows.every((r) => r.ndcg_at_k === 0 && r.relevance === 0);

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
          <h3 className="mb-4 text-sm font-semibold text-slate-700">Cost vs accuracy <span className="font-normal text-slate-400">(bubble = latency)</span></h3>
          <ResponsiveContainer width="100%" height={280}>
            <ScatterChart margin={{ left: -18, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
              <XAxis type="number" dataKey="x" name="cost" tick={{ fontSize: 11 }} unit="$" />
              <YAxis type="number" dataKey="y" name="nDCG" domain={[0, 1]} tick={{ fontSize: 11 }} />
              <ZAxis type="number" dataKey="z" range={[60, 420]} name="latency" />
              <Tooltip
                cursor={{ strokeDasharray: "3 3" }}
                contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12 }}
                formatter={(v: number, n: string) => [n === "cost" ? `$${v}` : v, n]}
              />
              <Scatter data={scatterData} fill="#4f46e5" fillOpacity={0.75} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3">
          <h3 className="text-sm font-semibold text-slate-700">All combinations</h3>
          <div className="flex items-center gap-2">
            <MetricsInfo />
            <button className="btn-secondary btn-sm" onClick={() => downloadCsv(rows)}>
              <Download className="h-3.5 w-3.5" /> CSV
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Combination</th>
                <th>Chunks</th>
                <th>Tokens</th>
                <th>Cost</th>
                <th>Latency</th>
                {METRIC_COLS.map((c) => <th key={c.key}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.combination_id}>
                  <td className="font-mono text-slate-700">{r.label}</td>
                  <td>{r.chunk_count}</td>
                  <td>{formatTokens(r.total_tokens)}</td>
                  <td>{formatCost(r.total_cost_usd)}</td>
                  <td>{formatMs(r.avg_retrieval_latency_ms)}</td>
                  {METRIC_COLS.map((c) => {
                    const v = r[c.key] as number;
                    const isBest = v > 0 && v === colMax[c.key as string];
                    return (
                      <td key={c.key} className={isBest ? "font-bold text-brand-700" : ""}>
                        {v.toFixed(3)}
                        {isBest && " ★"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
