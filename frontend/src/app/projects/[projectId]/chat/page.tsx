"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import { listRuns } from "@/lib/api";
import { ChatPanel } from "@/components/chat/ChatPanel";

type Scope = "project" | "run" | "compare";

export default function ChatPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: runs } = useQuery({ queryKey: ["runs", projectId], queryFn: () => listRuns(projectId) });
  const completed = runs?.filter((r) => r.status === "completed") ?? [];

  const [scope, setScope] = useState<Scope>("project");
  const [runId, setRunId] = useState("");
  const [runA, setRunA] = useState("");
  const [runB, setRunB] = useState("");

  const canSend =
    scope === "project" ||
    (scope === "run" && !!runId) ||
    (scope === "compare" && !!runA && !!runB && runA !== runB);

  return (
    <div>
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

      <ChatPanel
        key={`${scope}:${runId}:${runA}:${runB}`}
        projectId={projectId}
        scope={scope}
        runId={runId}
        runIds={[runA, runB]}
        canSend={canSend}
        heightClass="h-[calc(100vh-9rem)]"
      />
    </div>
  );
}
