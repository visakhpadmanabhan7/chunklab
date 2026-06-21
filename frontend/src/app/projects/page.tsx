"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, FlaskConical, FolderPlus, Plus, Sparkles, Trash2 } from "lucide-react";
import { createProject, deleteProject, listProjects } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { logger } from "@/lib/logger";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { Spinner } from "@/components/ui/Spinner";

export default function ProjectsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const { data: projects, isLoading } = useQuery({ queryKey: ["projects"], queryFn: listProjects });

  const create = useMutation({
    mutationFn: () => createProject(name, description || undefined),
    onSuccess: (p) => {
      logger.info("project.created", { id: p.id, name: p.name });
      setName("");
      setDescription("");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (e) => logger.error("project.create.failed", { error: (e as Error).message }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteProject(id),
    onSuccess: (_d, id) => {
      logger.warn("project.deleted", { id });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  return (
    <div>
      <PageHeader
        title="Projects"
        subtitle="Create a project, add documents, and run chunking experiments."
        actions={
          <button className="btn-primary" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> New project
          </button>
        }
      />

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : projects && projects.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <div key={p.id} className="card card-hover group relative overflow-hidden">
              <div className="h-1.5 w-full bg-gradient-to-r from-brand-500 to-sky-500" />
              <div className="p-5">
                <Link href={`/projects/${p.id}`} className="block">
                  <div className="mb-3 flex items-center gap-3">
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
                      <FlaskConical className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="truncate text-base font-semibold text-slate-900 group-hover:text-brand-700">
                        {p.name}
                      </h3>
                      <p className="truncate text-xs text-slate-400">
                        {formatDate(p.created_at)}
                      </p>
                    </div>
                  </div>
                  {p.description && (
                    <p className="mb-4 line-clamp-2 min-h-[2.5rem] text-sm text-slate-500">
                      {p.description}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <span className="chip">
                      <FileText className="h-3.5 w-3.5 text-slate-400" /> {p.file_count} files
                    </span>
                    <span className="chip">
                      <FlaskConical className="h-3.5 w-3.5 text-slate-400" /> {p.run_count} runs
                    </span>
                  </div>
                </Link>
                <button
                  className="absolute right-3 top-3 rounded-lg p-1.5 text-slate-300 opacity-0 transition hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100"
                  onClick={() => {
                    if (confirm(`Delete project "${p.name}"? This removes its files and runs.`))
                      remove.mutate(p.id);
                  }}
                  title="Delete project"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={FolderPlus}
          title="No projects yet"
          description="Create your first project to upload documents and start comparing chunking strategies."
          action={
            <button className="btn-primary" onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" /> New project
            </button>
          }
        />
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="card w-full max-w-lg p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
                <Sparkles className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-lg font-semibold">New project</h2>
                <p className="text-sm text-slate-500">Give it a name to get started.</p>
              </div>
            </div>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) create.mutate();
              }}
            >
              <div>
                <label className="label">Name</label>
                <input
                  className="input"
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Product docs RAG"
                />
              </div>
              <div>
                <label className="label">Description (optional)</label>
                <input
                  className="input"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What are you evaluating?"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
                  Cancel
                </button>
                <button className="btn-primary" disabled={!name.trim() || create.isPending}>
                  {create.isPending ? <Spinner /> : <Plus className="h-4 w-4" />} Create project
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
