import type {
  Combination,
  FileItem,
  Project,
  ProjectAnalytics,
  QAPair,
  Run,
  RunResults,
  TradeoffPoint,
} from "./types";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";
const V1 = `${API_BASE}/api/v1`;

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${V1}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail || detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ---- projects ----
export const listProjects = () => req<Project[]>("/projects");
export const getProject = (id: string) => req<Project>(`/projects/${id}`);
export const createProject = (name: string, description?: string) =>
  req<Project>("/projects", { method: "POST", body: JSON.stringify({ name, description }) });
export const deleteProject = (id: string) =>
  req<void>(`/projects/${id}`, { method: "DELETE" });

// ---- files ----
export const listFiles = (projectId: string) =>
  req<FileItem[]>(`/projects/${projectId}/files`);
export const deleteFile = (id: string) => req<void>(`/files/${id}`, { method: "DELETE" });
export interface ParseOptions {
  parser: "docling" | "fast";
  ocr: boolean;
  tables: boolean;
}

export function uploadFile(
  projectId: string,
  file: File,
  onProgress?: (pct: number) => void,
  options?: ParseOptions,
): Promise<FileItem> {
  // XHR (not fetch) so we get real upload-progress events.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${V1}/projects/${projectId}/files`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve(JSON.parse(xhr.responseText));
      } else {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    const form = new FormData();
    form.append("upload", file);
    const o = options ?? { parser: "docling", ocr: true, tables: true };
    form.append("parser", o.parser);
    form.append("ocr", String(o.ocr));
    form.append("tables", String(o.tables));
    xhr.send(form);
  });
}

// ---- runs ----
export interface RunCreatePayload {
  name: string;
  top_k?: number;
  combinations: { strategy: string; params: Record<string, unknown> }[];
  file_ids: string[] | "all";
}
export const createRun = (projectId: string, payload: RunCreatePayload) =>
  req<Run>(`/projects/${projectId}/runs`, { method: "POST", body: JSON.stringify(payload) });
export const listRuns = (projectId: string) =>
  req<Run[]>(`/projects/${projectId}/runs`);
export const getRun = (id: string) => req<Run>(`/runs/${id}`);
export const getCombinations = (id: string) =>
  req<Combination[]>(`/runs/${id}/combinations`);
export const cancelRun = (id: string) =>
  req<Run>(`/runs/${id}/cancel`, { method: "POST" });
export const deleteRun = (id: string) =>
  req<void>(`/runs/${id}`, { method: "DELETE" });

// ---- results / analytics ----
export const getResults = (runId: string) => req<RunResults>(`/runs/${runId}/results`);
export const getQAPairs = (runId: string) => req<QAPair[]>(`/runs/${runId}/qa-pairs`);
export const getTradeoff = (runId: string) =>
  req<{ run_id: string; points: TradeoffPoint[] }>(`/runs/${runId}/analytics/tradeoff`);
export const getProjectAnalytics = (projectId: string) =>
  req<ProjectAnalytics>(`/projects/${projectId}/analytics/runs`);
export const getProgressSnapshot = (runId: string) =>
  req<{ run_id: string; status: string; progress: number; events: unknown[] }>(
    `/runs/${runId}/progress`,
  );
export const getCombinationChunks = (combinationId: string) =>
  req<
    {
      id: string;
      file_id: string;
      chunk_index: number;
      content: string;
      token_count: number;
      char_count: number;
    }[]
  >(`/combinations/${combinationId}/chunks`);

export const progressStreamUrl = (runId: string) =>
  `${V1}/runs/${runId}/progress/stream`;

// ---- chat (streaming) ----
export interface ChatPayload {
  scope: "project" | "run" | "compare";
  project_id?: string;
  run_id?: string;
  run_ids?: string[];
  message: string;
  history: { role: "user" | "assistant"; content: string }[];
}
export async function chatStream(payload: ChatPayload): Promise<Response> {
  return fetch(`${V1}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
