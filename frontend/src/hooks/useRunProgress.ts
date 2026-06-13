"use client";

import { useEffect, useRef, useState } from "react";
import { progressStreamUrl } from "@/lib/api";
import type { ProgressEvent } from "@/lib/types";

interface RunProgressState {
  runStatus: string | null;
  runPct: number;
  combos: Record<string, { label: string; status: string; pct: number }>;
  files: Record<string, { comboId: string; fileId: string; stage: string; status: string; pct: number }>;
  logs: { key: string; level: string; message: string }[];
  connected: boolean;
}

const TERMINAL = new Set(["completed", "failed", "canceled"]);

export function useRunProgress(runId: string, enabled: boolean): RunProgressState {
  const [state, setState] = useState<RunProgressState>({
    runStatus: null,
    runPct: 0,
    combos: {},
    files: {},
    logs: [],
    connected: false,
  });
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const es = new EventSource(progressStreamUrl(runId));
    esRef.current = es;

    es.onopen = () => setState((s) => ({ ...s, connected: true }));
    es.onerror = () => setState((s) => ({ ...s, connected: false }));
    es.onmessage = (e) => {
      let ev: ProgressEvent;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      setState((s) => {
        const next = { ...s };
        if (ev.type === "run") {
          next.runStatus = ev.status;
          next.runPct = ev.pct;
          if (TERMINAL.has(ev.status)) es.close();
        } else if (ev.type === "combo") {
          next.combos = { ...s.combos, [ev.comboId]: { label: ev.label, status: ev.status, pct: ev.pct } };
        } else if (ev.type === "file") {
          next.files = {
            ...s.files,
            [ev.key]: { comboId: ev.comboId, fileId: ev.fileId, stage: ev.stage, status: ev.status, pct: ev.pct },
          };
        } else if (ev.type === "log") {
          next.logs = [...s.logs.slice(-40), { key: ev.key, level: ev.level, message: ev.message }];
        }
        return next;
      });
    };

    return () => es.close();
  }, [runId, enabled]);

  return state;
}
