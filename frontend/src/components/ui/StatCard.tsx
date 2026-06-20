import Link from "next/link";
import type { LucideIcon } from "lucide-react";

export function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  accent = "brand",
  href,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  icon?: LucideIcon;
  accent?: "brand" | "emerald" | "amber" | "sky";
  href?: string;
}) {
  const accents: Record<string, string> = {
    brand: "bg-brand-50 text-brand-600",
    emerald: "bg-emerald-50 text-emerald-600",
    amber: "bg-amber-50 text-amber-600",
    sky: "bg-sky-50 text-sky-600",
  };
  const inner = (
    <div className="flex items-start justify-between">
      <div className="min-w-0">
        <p className="stat-label">{label}</p>
        <p className="mt-1 truncate text-2xl font-bold text-slate-900">{value}</p>
        {sub && <p className="mt-0.5 truncate text-xs text-slate-500">{sub}</p>}
      </div>
      {Icon && (
        <span className={`rounded-xl p-2.5 ${accents[accent]}`}>
          <Icon className="h-5 w-5" />
        </span>
      )}
    </div>
  );

  if (href) {
    return (
      <Link href={href} className="card card-hover block p-5">
        {inner}
      </Link>
    );
  }
  return <div className="card p-5">{inner}</div>;
}
