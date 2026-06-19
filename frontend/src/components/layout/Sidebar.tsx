"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import {
  ArrowLeft,
  BarChart3,
  FileText,
  Folder,
  Info,
  KeyRound,
  LayoutDashboard,
  MessageSquare,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { getProject, listProjects } from "@/lib/api";
import { Logo } from "@/components/ui/Logo";

function NavItem({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={clsx(
        "group flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition",
        active
          ? "bg-gradient-to-r from-brand-50 to-brand-50/40 text-brand-700 shadow-sm ring-1 ring-brand-100"
          : "text-slate-600 hover:bg-slate-100/80 hover:text-slate-900",
      )}
    >
      <Icon className={clsx("h-[18px] w-[18px]", active ? "text-brand-600" : "text-slate-400 group-hover:text-slate-600")} />
      {label}
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const segs = pathname.split("/").filter(Boolean);
  const inProject = segs[0] === "projects" && segs.length >= 2;
  const projectId = inProject ? segs[1] : null;

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject(projectId!),
    enabled: !!projectId,
  });
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: listProjects });

  const base = `/projects/${projectId}`;
  const projectNav = projectId
    ? [
        { href: base, label: "Overview", icon: LayoutDashboard, active: pathname === base },
        { href: `${base}/files`, label: "Files", icon: FileText, active: pathname.startsWith(`${base}/files`) },
        { href: `${base}/runs`, label: "Runs", icon: BarChart3, active: pathname.startsWith(`${base}/runs`) },
        { href: `${base}/chat`, label: "Chat", icon: MessageSquare, active: pathname.startsWith(`${base}/chat`) },
      ]
    : [];

  return (
    <aside className="sticky top-0 flex h-screen w-64 shrink-0 flex-col border-r border-slate-200/80 bg-white/70 backdrop-blur-xl">
      <Link href="/projects" className="block px-5 py-5">
        <Logo size="md" />
      </Link>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3">
        {inProject ? (
          <>
            <Link
              href="/projects"
              className="mb-2 flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-400 transition hover:text-slate-600"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> All projects
            </Link>
            <div className="truncate px-3 pb-2 text-sm font-bold text-slate-800">
              {project?.name ?? "Project"}
            </div>
            {projectNav.map((n) => (
              <NavItem key={n.href} {...n} />
            ))}
          </>
        ) : (
          <>
            <NavItem
              href="/projects"
              label="All projects"
              icon={LayoutDashboard}
              active={pathname === "/projects"}
            />
            {(projects ?? []).length > 0 && (
              <p className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Projects
              </p>
            )}
            {(projects ?? []).map((p) => (
              <NavItem
                key={p.id}
                href={`/projects/${p.id}`}
                label={p.name}
                icon={Folder}
                active={pathname.startsWith(`/projects/${p.id}`)}
              />
            ))}
          </>
        )}
      </nav>

      <div className="space-y-1 border-t border-slate-200/70 px-3 py-3">
        <NavItem href="/assistant" label="Ask the docs" icon={Sparkles} active={pathname.startsWith("/assistant")} />
        <NavItem href="/about" label="About" icon={Info} active={pathname === "/about"} />
        <NavItem href="/settings" label="API keys" icon={KeyRound} active={pathname.startsWith("/settings")} />
        <p className="px-3 pt-2 text-[11px] text-slate-400">Groq · pgvector · FastEmbed</p>
      </div>
    </aside>
  );
}
