"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { getResults } from "@/lib/api";
import { formatCost, formatTokens } from "@/lib/format";
import type { ReportRow } from "@/lib/types";
import { PageHeader } from "@/components/ui/PageHeader";
import { CardSkeleton } from "@/components/ui/Skeleton";

function bestRow(rows: ReportRow[]): ReportRow | null {
  return rows.reduce<ReportRow | null>((a, b) => (!a || b.ndcg_at_k > a.ndcg_at_k ? b : a), null);
}

function RunCard({ runId, title, accent }: { runId: string; title: string; accent: string }) {
  const { data, isLoading } = useQuery({ queryKey: ["results", runId], queryFn: () => getResults(runId) });
  if (isLoading) return <CardSkeleton />;
  const rows = data?.combinations ?? [];
  const best = bestRow(rows);
  const totalCost = rows.reduce((s, r) => s + r.total_cost_usd, 0);
  const totalTokens = rows.reduce((s, r) => s + r.total_tokens, 0);
  const rowsEl = [
    ["Best combo", best?.label ?? "—"],
    ["Best nDCG", best?.ndcg_at_k.toFixed(3) ?? "—"],
    ["Best faithfulness", best?.faithfulness.toFixed(3) ?? "—"],
    ["Total cost", formatCost(totalCost)],
    ["Total tokens", formatTokens(totalTokens)],
    ["Combinations", String(rows.length)],
  ];
  return (
    <div className="card overflow-hidden">
      <div className={`h-1.5 w-full ${accent}`} />
      <div className="p-5">
        <p className="stat-label">{title}</p>
        <p className="mt-1 truncate text-lg font-bold">{data?.name}</p>
        <dl className="mt-4 space-y-2 text-sm">
          {rowsEl.map(([k, v]) => (
            <div key={k} className="flex justify-between border-b border-slate-50 pb-2">
              <dt className="text-slate-500">{k}</dt>
              <dd className="font-medium text-slate-800">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

export default function ComparePage() {
  const { runId } = useParams<{ runId: string }>();
  const withId = useSearchParams().get("with");

  return (
    <div>
      <PageHeader title="Compare runs" subtitle="Side-by-side summary of two runs." />
      <div className="grid gap-4 md:grid-cols-2">
        <RunCard runId={runId} title="Run A" accent="bg-gradient-to-r from-brand-500 to-brand-400" />
        {withId ? (
          <RunCard runId={withId} title="Run B" accent="bg-gradient-to-r from-sky-500 to-emerald-400" />
        ) : (
          <p className="card p-8 text-center text-sm text-slate-400">Pick a run to compare from the run page.</p>
        )}
      </div>
      <p className="mt-4 text-xs text-slate-500">
        Tip: open <strong>Chat</strong> in <strong>compare</strong> scope to ask how these runs differ.
      </p>
    </div>
  );
}
