export interface ParamField {
  key: string;
  label: string;
  type: "int";
  min: number;
  max: number;
  default: number;
}

export interface StrategyDef {
  id: string;
  label: string;
  description: string;
  params: ParamField[];
}

export const STRATEGIES: StrategyDef[] = [
  {
    id: "sentence",
    label: "Sentence-based",
    description: "Packs whole sentences up to a token target.",
    params: [
      { key: "size", label: "Tokens per chunk", type: "int", min: 32, max: 4096, default: 512 },
      { key: "overlap", label: "Overlap (tokens)", type: "int", min: 0, max: 1024, default: 20 },
    ],
  },
  {
    id: "character",
    label: "Character-based",
    description: "Fixed-size character windows with overlap.",
    params: [
      { key: "size", label: "Characters per chunk", type: "int", min: 50, max: 8000, default: 1000 },
      { key: "overlap", label: "Overlap (chars)", type: "int", min: 0, max: 2000, default: 100 },
    ],
  },
  {
    id: "recursive",
    label: "Recursive",
    description: "Hierarchical separators avoid cutting mid-sentence.",
    params: [
      { key: "chunk_size", label: "Chunk size", type: "int", min: 50, max: 8000, default: 512 },
      { key: "overlap", label: "Overlap", type: "int", min: 0, max: 2000, default: 64 },
    ],
  },
  {
    id: "token",
    label: "Token-based",
    description: "Sized by the embedding model's own tokens.",
    params: [
      { key: "size", label: "Tokens per chunk", type: "int", min: 16, max: 2048, default: 256 },
      { key: "overlap", label: "Overlap (tokens)", type: "int", min: 0, max: 512, default: 0 },
    ],
  },
  {
    id: "semantic",
    label: "Semantic",
    description: "New chunk where the topic shifts (embedding similarity).",
    params: [
      {
        key: "breakpoint_percentile",
        label: "Breakpoint percentile",
        type: "int",
        min: 50,
        max: 99,
        default: 95,
      },
    ],
  },
];

export function strategyById(id: string): StrategyDef | undefined {
  return STRATEGIES.find((s) => s.id === id);
}

/** Mirrors the backend label() functions for display + dedup. */
export function buildLabel(strategy: string, params: Record<string, number | string>): string {
  switch (strategy) {
    case "sentence":
      return `sentence·${params.size}/${params.overlap}`;
    case "character":
      return `character·${params.size}/${params.overlap}`;
    case "token":
      return `token·${params.size}/${params.overlap}`;
    case "recursive":
      return `recursive·${params.chunk_size}/${params.overlap}`;
    case "semantic":
      return `semantic·pct${params.breakpoint_percentile}`;
    default:
      return `${strategy}·${JSON.stringify(params)}`;
  }
}
