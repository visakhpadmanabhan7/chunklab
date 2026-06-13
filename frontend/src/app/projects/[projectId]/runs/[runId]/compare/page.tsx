"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { getResults } from "@/lib/api";
import { formatCost, formatTokens } from "@/lib/format";
import type { ReportRow } from "@/lib/types";
import { Spinner } from "@/components/ui/Spinner";

function bestRow(rows: ReportRow[]): ReportRow | null {
  return rows.reduce<ReportRow | null>((a, b) => (!a || b.ndcg_at_k > a.ndcg_at_k ? b : a), null);
}

function RunCard({ runId, title }: { runId: string; title: string }) {
  const { data, isLoading } = useQuery({ queryKey: ["results", runId], queryFn: () => getResults(runId) });
  if (isLoading) return <div className="card flex justify-center p-8"><Spinner /></div>;
  const rows = data?.combinations ?? [];
  const best = bestRow(rows);
  const totalCost = rows.reduce((s, r) => s + r.total_cost_usd, 0);
  const totalTokens = rows.reduce((s, r) => s + r.total_tokens, 0);
  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
      <p className="mt-1 truncate text-lg font-bold">{data?.name}</p>
      <dl className="mt-3 space-y-1 text-sm">
        <div className="flex justify-between"><dt className="text-slate-500">Best combo</dt><dd className="font-mono">{best?.label ?? "—"}</dd></div>
        <div className="flex justify-between"><dt className="text-slate-500">Best nDCG</dt><dd>{best?.ndcg_at_k.toFixed(3) ?? "—"}</dd></div>
        <div className="flex justify-between"><dt className="text-slate-500">Total cost</dt><dd>{formatCost(totalCost)}</dd></div>
        <div className="flex justify-between"><dt className="text-slate-500">Total tokens</dt><dd>{formatTokens(totalTokens)}</dd></div>
        <div className="flex justify-between"><dt className="text-slate-500">Combinations</dt><dd>{rows.length}</dd></div>
      </dl>
    </div>
  );
}

export default function ComparePage() {
  const { runId } = useParams<{ runId: string }>();
  const withId = useSearchParams().get("with");

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Compare runs</h1>
      <div className="grid gap-4 md:grid-cols-2">
        <RunCard runId={runId} title="Run A" />
        {withId ? <RunCard runId={withId} title="Run B" /> : <p className="text-sm text-slate-400">Pick a run to compare.</p>}
      </div>
      <p className="text-xs text-slate-500">
        Tip: use the chat in <strong>compare</strong> scope to ask how these two runs differ.
      </p>
    </div>
  );
}
