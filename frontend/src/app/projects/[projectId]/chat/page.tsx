"use client";

import { useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Bot, MessageSquare, Send, Sparkles } from "lucide-react";
import { chatStream, listRuns, type ChatPayload } from "@/lib/api";
import { logger } from "@/lib/logger";
import { Spinner } from "@/components/ui/Spinner";

type Msg = { role: "user" | "assistant"; content: string };
type Scope = "project" | "run" | "compare";

const SUGGESTIONS = [
  "Which combination gave the best nDCG and why?",
  "What's the cheapest strategy with acceptable accuracy?",
  "How does chunk size affect faithfulness here?",
];

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

  async function send(text: string) {
    text = text.trim();
    if (!text || sending) return;
    setInput("");
    const history = messages;
    setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);
    setSending(true);
    logger.info("chat.send", { scope });
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
          const c = [...m];
          c[c.length - 1] = { role: "assistant", content: c[c.length - 1].content + chunk };
          return c;
        });
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      }
    } catch (e) {
      logger.error("chat.failed", { scope, error: (e as Error).message });
      setMessages((m) => {
        const c = [...m];
        c[c.length - 1] = { role: "assistant", content: `⚠️ ${(e as Error).message}` };
        return c;
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
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      {/* control bar */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
            <MessageSquare className="h-5 w-5" />
          </span>
          <h1 className="text-xl font-bold">Chat</h1>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
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
      </div>

      {/* messages */}
      <div ref={scrollRef} className="card flex-1 space-y-5 overflow-auto p-6">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <span className="mb-3 rounded-2xl bg-gradient-to-br from-brand-500 to-sky-500 p-3 text-white">
              <Sparkles className="h-7 w-7" />
            </span>
            <p className="text-sm font-medium text-slate-700">Ask anything about your experiments</p>
            <p className="mt-1 text-sm text-slate-400">Answers are grounded in your run results.</p>
            <div className="mt-5 flex max-w-xl flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => canSend && send(s)}
                  disabled={!canSend}
                  className="chip hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "flex justify-end" : "flex items-start gap-2.5"}>
              {m.role === "assistant" && (
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                  <Bot className="h-4 w-4" />
                </span>
              )}
              <div
                className={
                  m.role === "user"
                    ? "max-w-[78%] rounded-2xl rounded-tr-sm bg-gradient-to-b from-brand-500 to-brand-600 px-4 py-2.5 text-sm text-white shadow-sm"
                    : "max-w-[78%] whitespace-pre-wrap rounded-2xl rounded-tl-sm bg-slate-100 px-4 py-2.5 text-sm text-slate-800"
                }
              >
                {m.content || <Spinner className="h-4 w-4" />}
              </div>
            </div>
          ))
        )}
      </div>

      {/* composer */}
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) send(input);
        }}
      >
        <input
          className="input flex-1"
          placeholder={canSend ? "Ask about this scope…" : "Select a completed run first…"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={!canSend}
        />
        <button className="btn-primary px-4" disabled={!canSend || sending || !input.trim()}>
          {sending ? <Spinner /> : <Send className="h-4 w-4" />}
        </button>
      </form>
    </div>
  );
}
