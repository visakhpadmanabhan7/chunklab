"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { BarChart3, FileText, LayoutDashboard, MessageSquare } from "lucide-react";
import { getProject } from "@/lib/api";

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const pathname = usePathname();
  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject(projectId),
  });

  const base = `/projects/${projectId}`;
  const nav = [
    { href: base, label: "Overview", icon: LayoutDashboard, exact: true },
    { href: `${base}/files`, label: "Files", icon: FileText },
    { href: `${base}/runs`, label: "Runs", icon: BarChart3 },
    { href: `${base}/chat`, label: "Chat", icon: MessageSquare },
  ];

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <aside className="lg:w-56 lg:shrink-0">
        <div className="mb-4">
          <Link href="/projects" className="text-xs text-slate-400 hover:text-slate-600">
            ← All projects
          </Link>
          <h2 className="mt-1 truncate text-lg font-bold">{project?.name || "Project"}</h2>
        </div>
        <nav className="flex gap-1 lg:flex-col">
          {nav.map((n) => {
            const active = n.exact ? pathname === n.href : pathname.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={clsx(
                  "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition",
                  active ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-100",
                )}
              >
                <n.icon className="h-4 w-4" />
                {n.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <section className="min-w-0 flex-1">{children}</section>
    </div>
  );
}
