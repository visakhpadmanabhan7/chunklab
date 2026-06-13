import clsx from "clsx";

export function Progress({ value, className }: { value: number; className?: string }) {
  const pct = Math.max(0, Math.min(100, value * 100));
  return (
    <div className={clsx("h-2 w-full overflow-hidden rounded-full bg-slate-200", className)}>
      <div
        className="h-full rounded-full bg-brand-600 transition-all duration-500"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
