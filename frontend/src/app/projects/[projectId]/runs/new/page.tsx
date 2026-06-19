"use client";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Layers, Plus, Rocket, X } from "lucide-react";
import { createRun, listFiles } from "@/lib/api";
import { STRATEGIES, buildLabel, strategyById } from "@/lib/strategies";
import { modelsFor } from "@/lib/providers";
import { useBuilderStore } from "@/store/builder-store";
import { useKeysStore } from "@/store/keys-store";
import { QASetManager } from "@/components/runs/QASetManager";
import { logger } from "@/lib/logger";
import { PageHeader } from "@/components/ui/PageHeader";
import { Spinner } from "@/components/ui/Spinner";

export default function NewRunPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const { combos, add, remove, clear } = useBuilderStore();

  const [name, setName] = useState(`Run ${new Date().toLocaleString()}`);
  const [topK, setTopK] = useState(5);
  const [qaPerFile, setQaPerFile] = useState(5);
  const [maxQa, setMaxQa] = useState(10);
  const [enableJudge, setEnableJudge] = useState(true);
  const savedKeys = useKeysStore((s) => s.keys);
  const [llmKeyId, setLlmKeyId] = useState("server");
  const llmKey = savedKeys.find((k) => k.id === llmKeyId);
  const llmModels = llmKey ? modelsFor(llmKey.provider) : [];
  const [llmModel, setLlmModel] = useState("");
  const [qaSource, setQaSource] = useState<"auto" | "mine" | "both">("auto");
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
    if (!add({ strategy: strategyId, params, label })) alert("That combination is already in the matrix.");
  }

  const fileCount = scope === "all" ? parsedFiles.length : selected.length;
  const totalJobs = combos.length * fileCount;

  const launch = useMutation({
    mutationFn: () =>
      createRun(projectId, {
        name,
        top_k: topK,
        qa_per_file: qaPerFile,
        max_qa: maxQa,
        enable_judge: enableJudge,
        ...(llmKey
          ? { provider: llmKey.provider, model: llmModel || llmModels[0], api_key: llmKey.key }
          : {}),
        qa_source: qaSource,
        combinations: combos.map((c) => ({ strategy: c.strategy, params: c.params })),
        file_ids: scope === "all" ? "all" : selected,
      }),
    onSuccess: (run) => {
      logger.info("run.launched", { id: run.id, combos: combos.length, files: fileCount });
      clear();
      router.push(`/projects/${projectId}/runs/${run.id}`);
    },
    onError: (e) => logger.error("run.launch.failed", { error: (e as Error).message }),
  });

  return (
    <div className="pb-24">
      <PageHeader
        title="New run"
        subtitle="Assemble a matrix of chunking strategies to compare."
        actions={
          <button className="btn-secondary" onClick={() => router.back()}>
            Cancel
          </button>
        }
      />

      <div className="grid gap-5 lg:grid-cols-5">
        <div className="space-y-5 lg:col-span-3">
          {/* run config */}
          <div className="card space-y-3 p-5">
            <div>
              <label className="label">Run name</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="label">Retrieval top-k</label>
                <input type="number" className="input" value={topK} min={1} max={20}
                  onChange={(e) => setTopK(Number(e.target.value))} />
              </div>
              <div>
                <label className="label">Questions / document</label>
                <input type="number" className="input" value={qaPerFile} min={1} max={20}
                  onChange={(e) => setQaPerFile(Number(e.target.value))} />
              </div>
              <div>
                <label className="label">Max total questions</label>
                <input type="number" className="input" value={maxQa} min={1} max={100}
                  onChange={(e) => setMaxQa(Number(e.target.value))} />
              </div>
            </div>
            <p className="text-xs text-slate-400">
              Questions are auto-generated once per run (shared across all combinations). Fewer
              questions = faster &amp; fewer LLM tokens.
            </p>
            <label className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
              <input type="checkbox" className="accent-brand-600" checked={enableJudge}
                onChange={(e) => setEnableJudge(e.target.checked)} />
              <span className="font-medium">Run LLM judge</span>
              <span className="text-xs text-slate-400">
                {enableJudge
                  ? "relevance + faithfulness (uses the LLM below)"
                  : "off — fast mode: computed metrics only, no judge calls"}
              </span>
            </label>
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-400">LLM · QA gen + judge</span>
              <select
                value={llmKeyId}
                onChange={(e) => { setLlmKeyId(e.target.value); setLlmModel(""); }}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 outline-none focus:border-brand-300"
              >
                <option value="server">Server default (Groq)</option>
                {savedKeys.map((k) => (
                  <option key={k.id} value={k.id}>{k.label} · {k.provider}</option>
                ))}
              </select>
              {llmKey && llmModels.length > 0 && (
                <select
                  value={llmModel || llmModels[0]}
                  onChange={(e) => setLlmModel(e.target.value)}
                  className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 outline-none focus:border-brand-300"
                >
                  {llmModels.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              )}
              <a href="/settings" className="ml-auto text-xs text-brand-600 hover:underline">Manage keys</a>
            </div>
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-400">Ground truth</span>
              <select
                value={qaSource}
                onChange={(e) => setQaSource(e.target.value as "auto" | "mine" | "both")}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 outline-none focus:border-brand-300"
              >
                <option value="auto">Auto-generate (Groq)</option>
                <option value="mine">My QA set only</option>
                <option value="both">Both</option>
              </select>
            </div>
            {qaSource !== "auto" && <QASetManager projectId={projectId} />}
          </div>

          {/* strategy picker */}
          <div className="card p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-700">1 · Choose a strategy</h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {STRATEGIES.map((s) => (
                <button
                  key={s.id}
                  onClick={() => pickStrategy(s.id)}
                  className={`rounded-xl border p-3 text-left transition ${
                    strategyId === s.id
                      ? "border-brand-400 bg-brand-50 ring-1 ring-brand-200"
                      : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
                  }`}
                >
                  <p className={`text-sm font-semibold ${strategyId === s.id ? "text-brand-700" : "text-slate-700"}`}>
                    {s.label}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-[11px] text-slate-400">{s.description}</p>
                </button>
              ))}
            </div>

            <h2 className="mb-3 mt-5 text-sm font-semibold text-slate-700">2 · Set parameters</h2>
            <div className="flex flex-wrap items-end gap-3">
              {strategy.params.map((p) => (
                <div key={p.key}>
                  <label className="label">{p.label}</label>
                  <input
                    type="number"
                    className="input w-40"
                    value={params[p.key]}
                    min={p.min}
                    max={p.max}
                    onChange={(e) => setParams({ ...params, [p.key]: Number(e.target.value) })}
                  />
                </div>
              ))}
              <button className="btn-primary" onClick={addCombo}>
                <Plus className="h-4 w-4" /> Add to matrix
              </button>
            </div>
          </div>

          {/* file scope */}
          <div className="card p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-700">3 · Files</h2>
            <div className="flex gap-2">
              <button
                onClick={() => setScope("all")}
                className={`flex-1 rounded-xl border p-3 text-left text-sm transition ${
                  scope === "all" ? "border-brand-400 bg-brand-50 text-brand-700" : "border-slate-200 hover:bg-slate-50"
                }`}
              >
                <p className="font-semibold">All parsed files</p>
                <p className="text-xs text-slate-400">{parsedFiles.length} files</p>
              </button>
              <button
                onClick={() => setScope("select")}
                className={`flex-1 rounded-xl border p-3 text-left text-sm transition ${
                  scope === "select" ? "border-brand-400 bg-brand-50 text-brand-700" : "border-slate-200 hover:bg-slate-50"
                }`}
              >
                <p className="font-semibold">Choose files</p>
                <p className="text-xs text-slate-400">Pick a subset</p>
              </button>
            </div>
            {scope === "select" && (
              <div className="mt-3 space-y-1.5">
                {parsedFiles.map((f) => (
                  <label key={f.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50">
                    <input
                      type="checkbox"
                      className="accent-brand-600"
                      checked={selected.includes(f.id)}
                      onChange={(e) =>
                        setSelected((s) => (e.target.checked ? [...s, f.id] : s.filter((x) => x !== f.id)))
                      }
                    />
                    {f.filename}
                  </label>
                ))}
                {parsedFiles.length === 0 && <p className="text-xs text-slate-400">No parsed files yet.</p>}
              </div>
            )}
          </div>
        </div>

        {/* matrix summary */}
        <div className="lg:col-span-2">
          <div className="card sticky top-6 p-5">
            <div className="mb-3 flex items-center gap-2">
              <Layers className="h-4 w-4 text-brand-600" />
              <h2 className="text-sm font-semibold text-slate-700">Matrix ({combos.length})</h2>
              {combos.length > 0 && (
                <button onClick={clear} className="ml-auto text-xs text-slate-400 hover:text-rose-600">
                  clear all
                </button>
              )}
            </div>
            {combos.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-sm text-slate-400">
                Add strategies to build your comparison matrix.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {combos.map((c) => (
                  <span key={c.label} className="chip bg-brand-50 font-mono text-brand-700 ring-1 ring-brand-100">
                    {c.label}
                    <button onClick={() => remove(c.label)} className="text-brand-400 hover:text-rose-600">
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="mt-5 rounded-xl bg-slate-50 p-4 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Combinations</span>
                <span className="font-semibold">{combos.length}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Files</span>
                <span className="font-semibold">{fileCount}</span>
              </div>
              <div className="mt-2 flex items-center justify-between border-t border-slate-200 pt-2">
                <span className="text-slate-500">Total chunking jobs</span>
                <span className="text-lg font-bold text-brand-700">{totalJobs}</span>
              </div>
            </div>

            <button
              className="btn-primary mt-4 w-full"
              disabled={combos.length === 0 || fileCount === 0 || launch.isPending}
              onClick={() => launch.mutate()}
            >
              {launch.isPending ? <Spinner /> : <Rocket className="h-4 w-4" />} Launch run
            </button>
            {fileCount === 0 && (
              <p className="mt-2 text-center text-xs text-amber-600">Upload & parse files first.</p>
            )}
            {launch.isError && (
              <p className="mt-2 text-center text-xs text-rose-600">{(launch.error as Error).message}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
