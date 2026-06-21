export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(4)}`;
}

export function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

export function formatPct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

// The backend sends naive UTC timestamps (datetime.utcnow(), no tz suffix), which
// JS would otherwise parse as *local* time — adding a phantom offset (e.g. +2h).
// Normalize to UTC by appending 'Z' when no timezone marker is present.
export function parseApiDate(s: string): Date {
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z");
}

export function formatDateTime(s: string): string {
  return parseApiDate(s).toLocaleString();
}

export function formatDate(s: string): string {
  return parseApiDate(s).toLocaleDateString();
}

export function statusColor(status: string): string {
  switch (status) {
    case "completed":
      return "bg-emerald-100 text-emerald-700";
    case "running":
    case "chunking":
    case "embedding":
    case "evaluating":
    case "parsing":
      return "bg-amber-100 text-amber-700";
    case "failed":
      return "bg-rose-100 text-rose-700";
    case "canceled":
      return "bg-slate-200 text-slate-600";
    case "queued":
    case "uploaded":
      return "bg-slate-100 text-slate-600";
    case "parsed":
      return "bg-sky-100 text-sky-700";
    default:
      return "bg-slate-100 text-slate-600";
  }
}
