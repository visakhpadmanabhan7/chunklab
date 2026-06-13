"use client";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Rocket, X } from "lucide-react";
import { createRun, listFiles } from "@/lib/api";
import { STRATEGIES, buildLabel, strategyById } from "@/lib/strategies";
import { useBuilderStore } from "@/store/builder-store";
import { Spinner } from "@/components/ui/Spinner";

export default function NewRunPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const { combos, add, remove, clear } = useBuilderStore();

  const [name, setName] = useState(`Run ${new Date().toLocaleString()}`);
  const [topK, setTopK] = useState(5);
  const [strategyId, setStrategyId] = useState("sentence");
  const strategy = strategyById(strategyId)!;
  const [params, setParams] = useState<Record<string, number>>(
    Object.fromEntries(strategy.params.map((p) => [p.key, p.default])),
  );
  const [scope, setScope] = useState<"all" | "select">("all");
  const [selected, setSelected] = useState<string[]>([]);

  const { data: files } = useQuery({ queryKey: ["files", projectId], queryFn: () => listFiles(projectId) });
  const parsedFiles = useMemo(() => files?.filter((f) => f.status === "parsed") ?? [], [files]);

  function pickStrategy(id: string) {
    setStrategyId(id);
    const def = strategyById(id)!;
    setParams(Object.fromEntries(def.params.map((p) => [p.key, p.default])));
  }

  function addCombo() {
    const label = buildLabel(strategyId, params);
    if (!add({ strategy: strategyId, params, label })) {
      alert("That combination is already in the matrix.");
    }
  }

  const fileCount = scope === "all" ? parsedFiles.length : selected.length;
  const totalJobs = combos.length * fileCount;

  const launch = useMutation({
    mutationFn: () =>
      createRun(projectId, {
        name,
        top_k: topK,
        combinations: combos.map((c) => ({ strategy: c.strategy, params: c.params })),
        file_ids: scope === "all" ? "all" : selected,
      }),
    onSuccess: (run) => {
      clear();
      router.push(`/projects/${projectId}/runs/${run.id}`);
    },
  });

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">New run · build chunking matrix</h1>

      <div className="card space-y-4 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Run name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="label">Retrieval top-k</label>
            <input
              type="number"
              className="input"
              value={topK}
              min={1}
              max={20}
              onChange={(e) => setTopK(Number(e.target.value))}
            />
          </div>
        </div>
      </div>

      {/* draft strategy form */}
      <div className="card space-y-4 p-5">
        <h2 className="text-sm font-semibold text-slate-700">Add a strategy</h2>
        <div className="flex flex-wrap gap-2">
          {STRATEGIES.map((s) => (
            <button
              key={s.id}
              onClick={() => pickStrategy(s.id)}
              className={
                strategyId === s.id
                  ? "btn bg-brand-600 text-white"
                  : "btn-secondary"
              }
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-slate-500">{strategy.description}</p>
        <div className="flex flex-wrap items-end gap-3">
          {strategy.params.map((p) => (
            <div key={p.key}>
              <label className="label">{p.label}</label>
              <input
                type="number"
                className="input w-44"
                value={params[p.key]}
                min={p.min}
                max={p.max}
                onChange={(e) => setParams({ ...params, [p.key]: Number(e.target.value) })}
              />
            </div>
          ))}
          <button className="btn-primary" onClick={addCombo}>
            <Plus className="h-4 w-4" /> Add combination
          </button>
        </div>
      </div>

      {/* matrix */}
      <div className="card space-y-3 p-5">
        <h2 className="text-sm font-semibold text-slate-700">
          Selected combinations ({combos.length})
        </h2>
        {combos.length === 0 ? (
          <p className="text-sm text-slate-400">No combinations yet — add some above.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {combos.map((c) => (
              <span
                key={c.label}
                className="badge gap-1 bg-brand-50 font-mono text-brand-700"
              >
                {c.label}
                <button onClick={() => remove(c.label)} className="hover:text-rose-600">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* file scope */}
      <div className="card space-y-3 p-5">
        <h2 className="text-sm font-semibold text-slate-700">Files</h2>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" checked={scope === "all"} onChange={() => setScope("all")} />
            All parsed files ({parsedFiles.length})
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={scope === "select"} onChange={() => setScope("select")} />
            Choose
          </label>
        </div>
        {scope === "select" && (
          <div className="space-y-1">
            {parsedFiles.map((f) => (
              <label key={f.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(f.id)}
                  onChange={(e) =>
                    setSelected((s) =>
                      e.target.checked ? [...s, f.id] : s.filter((x) => x !== f.id),
                    )
                  }
                />
                {f.filename}
              </label>
            ))}
          </div>
        )}
      </div>

      {/* summary + launch */}
      <div className="card flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-slate-600">
          <span className="font-semibold text-slate-800">{combos.length}</span> combinations ×{" "}
          <span className="font-semibold text-slate-800">{fileCount}</span> files ={" "}
          <span className="font-semibold text-brand-700">{totalJobs}</span> chunking jobs
        </div>
        <button
          className="btn-primary"
          disabled={combos.length === 0 || fileCount === 0 || launch.isPending}
          onClick={() => launch.mutate()}
        >
          {launch.isPending ? <Spinner /> : <Rocket className="h-4 w-4" />} Launch run
        </button>
      </div>
      {launch.isError && (
        <p className="text-sm text-rose-600">{(launch.error as Error).message}</p>
      )}
    </div>
  );
}
