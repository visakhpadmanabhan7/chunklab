import clsx from "clsx";
import { statusColor } from "@/lib/format";

export function Badge({ status, children }: { status?: string; children: React.ReactNode }) {
  return (
    <span className={clsx("badge", status ? statusColor(status) : "bg-slate-100 text-slate-600")}>
      {children}
    </span>
  );
}
