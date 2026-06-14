"use client";

import { API_BASE } from "./api";

type Level = "debug" | "info" | "warn" | "error";

interface Ev {
  level: Level;
  event: string;
  detail?: Record<string, unknown>;
  path?: string;
}

const buffer: Ev[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

const CSS: Record<Level, string> = {
  debug: "color:#94a3b8",
  info: "color:#4f46e5",
  warn: "color:#b45309;font-weight:600",
  error: "color:#e11d48;font-weight:700",
};

function flush() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!buffer.length) return;
  const events = buffer.splice(0, buffer.length);
  // best-effort; never block the UI on logging
  fetch(`${API_BASE}/api/v1/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events }),
    keepalive: true,
  }).catch(() => {});
}

function emit(level: Level, event: string, detail?: Record<string, unknown>) {
  const path = typeof window !== "undefined" ? window.location.pathname : undefined;
  // console (color-coded by level)
  if (typeof console !== "undefined") {
    console.log(`%c[${level}] ${event}`, CSS[level], detail ?? "");
  }
  buffer.push({ level, event, detail, path });
  // warnings/errors ship immediately; info/debug are batched
  if (level === "warn" || level === "error") flush();
  else if (!timer) timer = setTimeout(flush, 2500);
}

let installed = false;
export function installGlobalLogging() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e) =>
    emit("error", "window.error", { message: e.message, source: e.filename }),
  );
  window.addEventListener("unhandledrejection", (e) =>
    emit("error", "unhandledrejection", { reason: String((e as PromiseRejectionEvent).reason) }),
  );
  window.addEventListener("beforeunload", flush);
}

export const logger = {
  debug: (event: string, detail?: Record<string, unknown>) => emit("debug", event, detail),
  info: (event: string, detail?: Record<string, unknown>) => emit("info", event, detail),
  warn: (event: string, detail?: Record<string, unknown>) => emit("warn", event, detail),
  error: (event: string, detail?: Record<string, unknown>) => emit("error", event, detail),
};
