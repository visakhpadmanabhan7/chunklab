"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, KeyRound, Trash2 } from "lucide-react";
import { PROVIDERS, type Provider } from "@/lib/providers";
import { useKeysStore } from "@/store/keys-store";

export default function SettingsPage() {
  const { keys, add, remove } = useKeysStore();
  const [label, setLabel] = useState("");
  const [provider, setProvider] = useState<Provider>("openai");
  const [key, setKey] = useState("");

  function save() {
    if (!label.trim() || !key.trim()) return;
    add({ label: label.trim(), provider, key: key.trim() });
    setLabel("");
    setKey("");
  }

  const mask = (k: string) => (k.length <= 8 ? "••••" : `${k.slice(0, 4)}…${k.slice(-4)}`);

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <Link href="/projects" className="mb-4 inline-flex items-center gap-2 text-xs font-medium text-slate-400 hover:text-slate-600">
        <ArrowLeft className="h-3.5 w-3.5" /> All projects
      </Link>
      <div className="mb-1 flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-brand-600" />
        <h1 className="text-2xl font-bold tracking-tight">API keys</h1>
      </div>
      <p className="mb-6 text-sm text-slate-500">
        Bring your own provider keys. They are saved <strong>only in this browser</strong> (localStorage) and
        attached to a chat/run request when you pick them — <strong>never stored on the server</strong>.
      </p>

      {/* add key */}
      <div className="card space-y-3 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Name</label>
            <input className="input" placeholder="e.g. my-openai" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div>
            <label className="label">Provider</label>
            <select className="input" value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="label">API key</label>
          <input className="input font-mono" type="password" placeholder="sk-…" value={key} onChange={(e) => setKey(e.target.value)} />
        </div>
        <button className="btn-primary" onClick={save} disabled={!label.trim() || !key.trim()}>
          Save key
        </button>
      </div>

      {/* saved keys */}
      <h2 className="mb-2 mt-7 text-sm font-semibold text-slate-700">Saved keys ({keys.length})</h2>
      {keys.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-sm text-slate-400">
          No keys yet. Add one above to use OpenAI / Anthropic / your own Groq key in chat.
        </p>
      ) : (
        <div className="card divide-y divide-slate-100">
          {keys.map((k) => (
            <div key={k.id} className="flex items-center gap-3 px-4 py-3">
              <span className="rounded-md bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700">
                {PROVIDERS.find((p) => p.id === k.provider)?.label ?? k.provider}
              </span>
              <span className="font-medium text-slate-700">{k.label}</span>
              <span className="font-mono text-xs text-slate-400">{mask(k.key)}</span>
              <button onClick={() => remove(k.id)} className="ml-auto text-slate-400 hover:text-rose-600" title="Delete">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
