"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Coins, FlaskConical, LineChart, Trophy } from "lucide-react";
import { getProjectAnalytics } from "@/lib/api";
import { formatCost, formatTokens } from "@/lib/format";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { CardSkeleton } from "@/components/ui/Skeleton";

const BAR_COLORS = ["#4f46e5", "#0ea5e9", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6"];

export default function AnalyticsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data, isLoading } = useQuery({
    queryKey: ["project-analytics", projectId],
    queryFn: () => getProjectAnalytics(projectId),
  });

  if (isLoading)
    return (
      <div>
        <PageHeader title="Analytics" subtitle="Compare every run in this project." />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <CardSkeleton key={i} />)}</div>
      </div>
    );

  const runs = (data?.runs ?? []).filter((r) => r.status === "completed");

  if (runs.length === 0)
    return (
      <div>
        <PageHeader title="Analytics" subtitle="Compare every run in this project." />
        <EmptyState
          icon={LineChart}
          title="No completed runs to analyze"
          description="Once a run finishes, cross-run analytics appear here — best strategy, accuracy, cost, and tokens per run."
          action={
            <Link href={`/projects/${projectId}/runs/new`} className="btn-primary">
              New run
            </Link>
          }
        />
      </div>
    );

  const totalSpend = runs.reduce((s, r) => s + r.total_cost_usd, 0);
  const totalTokens = runs.reduce((s, r) => s + r.total_tokens, 0);
  const champion = runs.reduce((a, b) => (b.best_ndcg > a.best_ndcg ? b : a));

  const ndcgData = runs.map((r) => ({ name: r.name, ndcg: r.best_ndcg }));
  const costData = runs.map((r) => ({ name: r.name, cost: r.total_cost_usd }));

  return (
    <div>
      <PageHeader title="Analytics" subtitle="Cross-run comparison for this project." />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Completed runs" value={runs.length} icon={FlaskConical} accent="brand" />
        <StatCard label="Best run (nDCG)" value={champion.name} sub={`${champion.best_label ?? "—"} · ${champion.best_ndcg.toFixed(3)}`} icon={Trophy} accent="amber" />
        <StatCard label="Total spend" value={formatCost(totalSpend)} sub="all runs (notional + Groq)" icon={Coins} accent="emerald" />
        <StatCard label="Total tokens" value={formatTokens(totalTokens)} icon={LineChart} accent="sky" />
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <div className="card p-5">
          <h3 className="mb-4 text-sm font-semibold text-slate-700">Best nDCG per run</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={ndcgData} margin={{ left: -18 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-18} textAnchor="end" height={64} />
              <YAxis domain={[0, 1]} tick={{ fontSize: 11 }} />
              <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12 }} />
              <Bar dataKey="ndcg" radius={[4, 4, 0, 0]}>
                {ndcgData.map((_, i) => <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card p-5">
          <h3 className="mb-4 text-sm font-semibold text-slate-700">Total cost per run</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={costData} margin={{ left: -8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-18} textAnchor="end" height={64} />
              <YAxis tick={{ fontSize: 11 }} unit="$" />
              <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12 }} formatter={(v: number) => [`$${v}`, "cost"]} />
              <Bar dataKey="cost" radius={[4, 4, 0, 0]}>
                {costData.map((_, i) => <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card mt-6 overflow-hidden">
        <h3 className="px-5 py-3 text-sm font-semibold text-slate-700">All runs</h3>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Run</th>
                <th>Combinations</th>
                <th>Best combo</th>
                <th>Best nDCG</th>
                <th>Cost</th>
                <th>Tokens</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.run_id}>
                  <td className="font-medium text-slate-800">{r.name}</td>
                  <td>{r.combinations}</td>
                  <td className="font-mono text-xs text-slate-600">{r.best_label ?? "—"}</td>
                  <td className="font-semibold">{r.best_ndcg.toFixed(3)}</td>
                  <td>{formatCost(r.total_cost_usd)}</td>
                  <td>{formatTokens(r.total_tokens)}</td>
                  <td>
                    <Link href={`/projects/${projectId}/runs/${r.run_id}`} className="text-brand-600 hover:underline">
                      open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
