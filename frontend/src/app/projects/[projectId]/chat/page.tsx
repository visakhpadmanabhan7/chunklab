"use client";

import { useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { chatStream, listRuns, type ChatPayload } from "@/lib/api";
import { Spinner } from "@/components/ui/Spinner";

type Msg = { role: "user" | "assistant"; content: string };
type Scope = "project" | "run" | "compare";

export default function ChatPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: runs } = useQuery({ queryKey: ["runs", projectId], queryFn: () => listRuns(projectId) });
  const completed = runs?.filter((r) => r.status === "completed") ?? [];

  const [scope, setScope] = useState<Scope>("project");
  const [runId, setRunId] = useState("");
  const [runA, setRunA] = useState("");
  const [runB, setRunB] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    const history = messages;
    setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);
    setSending(true);

    const payload: ChatPayload = { scope, message: text, history, project_id: projectId };
    if (scope === "run") payload.run_id = runId;
    if (scope === "compare") payload.run_ids = [runA, runB];

    try {
      const res = await chatStream(payload);
      if (!res.ok || !res.body) throw new Error(await res.text());
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = {
            role: "assistant",
            content: copy[copy.length - 1].content + chunk,
          };
          return copy;
        });
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      }
    } catch (e) {
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = { role: "assistant", content: `⚠️ ${(e as Error).message}` };
        return copy;
      });
    } finally {
      setSending(false);
    }
  }

  const canSend =
    scope === "project" ||
    (scope === "run" && runId) ||
    (scope === "compare" && runA && runB && runA !== runB);

  return (
    <div className="flex h-[calc(100vh-12rem)] flex-col space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">Chat</h1>
        <select className="input w-auto" value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
          <option value="project">Whole project</option>
          <option value="run">Single run</option>
          <option value="compare">Compare two runs</option>
        </select>
        {scope === "run" && (
          <select className="input w-auto" value={runId} onChange={(e) => setRunId(e.target.value)}>
            <option value="">Pick a run…</option>
            {completed.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}
        {scope === "compare" && (
          <>
            <select className="input w-auto" value={runA} onChange={(e) => setRunA(e.target.value)}>
              <option value="">Run A…</option>
              {completed.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <select className="input w-auto" value={runB} onChange={(e) => setRunB(e.target.value)}>
              <option value="">Run B…</option>
              {completed.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </>
        )}
      </div>

      <div ref={scrollRef} className="card flex-1 space-y-4 overflow-auto p-5">
        {messages.length === 0 && (
          <p className="text-sm text-slate-400">
            Ask about your runs — e.g. “which combination gave the best nDCG and why?”
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={
                m.role === "user"
                  ? "max-w-[80%] rounded-2xl bg-brand-600 px-4 py-2 text-sm text-white"
                  : "max-w-[80%] whitespace-pre-wrap rounded-2xl bg-slate-100 px-4 py-2 text-sm text-slate-800"
              }
            >
              {m.content || <Spinner className="h-4 w-4" />}
            </div>
          </div>
        ))}
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) send();
        }}
      >
        <input
          className="input flex-1"
          placeholder={canSend ? "Ask about this scope…" : "Select a run first…"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={!canSend}
        />
        <button className="btn-primary" disabled={!canSend || sending || !input.trim()}>
          {sending ? <Spinner /> : <Send className="h-4 w-4" />}
        </button>
      </form>
    </div>
  );
}
