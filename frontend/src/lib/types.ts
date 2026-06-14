export interface Project {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  file_count: number;
  run_count: number;
}

export interface FileItem {
  id: string;
  project_id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  status: string; // uploaded | parsing | parsed | failed
  parser_used: string | null;
  error: string | null;
  created_at: string;
}

export interface Combination {
  id: string;
  run_id: string;
  strategy: string;
  params: Record<string, unknown>;
  label: string;
  status: string;
  progress: number;
}

export interface Run {
  id: string;
  project_id: string;
  name: string;
  status: string;
  progress: number;
  total_combinations: number;
  embedding_model: string;
  top_k: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  combinations?: Combination[];
}

export interface ReportRow {
  combination_id: string;
  label: string;
  strategy: string;
  params: Record<string, unknown>;
  status: string;
  chunk_count: number;
  total_tokens: number;
  avg_tokens_per_chunk: number;
  embedding_cost_usd: number;
  judge_cost_usd: number;
  total_cost_usd: number;
  chunk_latency_ms: number;
  embed_latency_ms: number;
  eval_latency_ms: number;
  relevance: number;
  faithfulness: number;
  context_precision: number;
  context_recall: number;
  precision_at_k: number;
  recall_at_k: number;
  mrr: number;
  ndcg_at_k: number;
  f2: number;
  avg_retrieval_latency_ms: number;
}

export interface RunResults {
  run_id: string;
  name: string;
  status: string;
  top_k: number;
  combinations: ReportRow[];
}

export interface QAPair {
  id: string;
  file_id: string;
  question: string;
  reference_answer: string;
}

export interface TradeoffPoint {
  label: string;
  strategy: string;
  cost: number;
  accuracy: number;
  latency_ms: number;
  tokens: number;
}

export interface RunSummary {
  run_id: string;
  name: string;
  status: string;
  combinations: number;
  best_label: string | null;
  best_ndcg: number;
  total_cost_usd: number;
  total_tokens: number;
}

export interface ProjectAnalytics {
  project_id: string;
  runs: RunSummary[];
}

export type ProgressEvent =
  | { type: "run"; key: string; status: string; pct: number }
  | { type: "combo"; key: string; comboId: string; label: string; status: string; pct: number }
  | { type: "file"; key: string; comboId: string; fileId: string; stage: string; status: string; pct: number }
  | { type: "log"; key: string; level: string; message: string };

// builder
export interface DraftCombination {
  strategy: string;
  params: Record<string, number | string>;
  label: string;
}
