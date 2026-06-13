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
import { getResults } from "@/lib/api";
import { formatCost, formatMs, formatTokens } from "@/lib/format";
import type { ReportRow } from "@/lib/types";
import { Spinner } from "@/components/ui/Spinner";

function Kpi({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs uppercase text-slate-400">{title}</p>
      <p className="mt-1 truncate text-lg font-bold">{value}</p>
      {sub && <p className="truncate text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

const METRIC_COLS: { key: keyof ReportRow; label: string }[] = [
  { key: "relevance", label: "relev" },
  { key: "faithfulness", label: "faith" },
  { key: "precision_at_k", label: "P@k" },
  { key: "recall_at_k", label: "recall" },
  { key: "mrr", label: "mrr" },
  { key: "ndcg_at_k", label: "ndcg" },
  { key: "f2", label: "f2" },
];

export function ResultsDashboard({ runId }: { runId: string }) {
  const { data, isLoading } = useQuery({ queryKey: ["results", runId], queryFn: () => getResults(runId) });

  if (isLoading) return <div className="flex justify-center py-12"><Spinner className="h-6 w-6 text-brand-600" /></div>;
  const rows = data?.combinations ?? [];
  if (rows.length === 0) return <p className="py-8 text-center text-sm text-slate-400">No results.</p>;

  const best = (sel: (r: ReportRow) => number, dir: "max" | "min" = "max") =>
    rows.reduce((a, b) => {
      const av = sel(a), bv = sel(b);
      return (dir === "max" ? bv > av : bv < av) ? b : a;
    });

  const bestNdcg = best((r) => r.ndcg_at_k);
  const costRows = rows.filter((r) => r.total_cost_usd > 0);
  const lowestCost = (costRows.length ? costRows : rows).reduce((a, b) =>
    b.total_cost_usd < a.total_cost_usd ? b : a,
  );
  const fastest = best((r) => r.avg_retrieval_latency_ms, "min");
  const bestValue = best((r) => (r.total_cost_usd > 0 ? r.ndcg_at_k / r.total_cost_usd : r.ndcg_at_k));

  const barData = rows.map((r) => ({
    label: r.label,
    relev: r.relevance,
    faith: r.faithfulness,
    "P@k": r.precision_at_k,
    ndcg: r.ndcg_at_k,
  }));
  const scatterData = rows.map((r) => ({
    x: r.total_cost_usd,
    y: r.ndcg_at_k,
    z: r.avg_retrieval_latency_ms,
    label: r.label,
  }));

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi title="Best nDCG" value={bestNdcg.label} sub={bestNdcg.ndcg_at_k.toFixed(3)} />
        <Kpi title="Lowest cost" value={lowestCost.label} sub={`${formatCost(lowestCost.total_cost_usd)} / run`} />
        <Kpi title="Fastest retrieval" value={fastest.label} sub={formatMs(fastest.avg_retrieval_latency_ms)} />
        <Kpi title="Best accuracy / $" value={bestValue.label} sub={bestValue.ndcg_at_k.toFixed(3)} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="card p-5">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">Accuracy by combination</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={barData} margin={{ left: -16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={60} />
              <YAxis domain={[0, 1]} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="ndcg" fill="#4f46e5" />
              <Bar dataKey="P@k" fill="#818cf8" />
              <Bar dataKey="faith" fill="#34d399" />
              <Bar dataKey="relev" fill="#fbbf24" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card p-5">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">Cost vs accuracy (bubble = latency)</h3>
          <ResponsiveContainer width="100%" height={280}>
            <ScatterChart margin={{ left: -16, bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
              <XAxis type="number" dataKey="x" name="cost" tick={{ fontSize: 11 }} unit="$" />
              <YAxis type="number" dataKey="y" name="nDCG" domain={[0, 1]} tick={{ fontSize: 11 }} />
              <ZAxis type="number" dataKey="z" range={[60, 400]} name="latency" />
              <Tooltip
                cursor={{ strokeDasharray: "3 3" }}
                formatter={(v: number, n: string) => [n === "cost" ? `$${v}` : v, n]}
                labelFormatter={() => ""}
              />
              <Scatter data={scatterData} fill="#4f46e5" />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card overflow-x-auto p-1">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
              <th className="px-3 py-2">Combination</th>
              <th className="px-3 py-2">Tokens</th>
              <th className="px-3 py-2">Cost</th>
              <th className="px-3 py-2">Lat</th>
              {METRIC_COLS.map((c) => (
                <th key={c.key} className="px-3 py-2">{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.combination_id} className="border-b border-slate-50 hover:bg-slate-50">
                <td className="px-3 py-2 font-mono">{r.label}</td>
                <td className="px-3 py-2">{formatTokens(r.total_tokens)}</td>
                <td className="px-3 py-2">{formatCost(r.total_cost_usd)}</td>
                <td className="px-3 py-2">{formatMs(r.avg_retrieval_latency_ms)}</td>
                {METRIC_COLS.map((c) => (
                  <td key={c.key} className="px-3 py-2">{(r[c.key] as number).toFixed(3)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
