"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, FlaskConical, Plus, Trash2 } from "lucide-react";
import { createProject, deleteProject, listProjects } from "@/lib/api";
import { Spinner } from "@/components/ui/Spinner";

export default function ProjectsPage() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const { data: projects, isLoading } = useQuery({ queryKey: ["projects"], queryFn: listProjects });

  const create = useMutation({
    mutationFn: () => createProject(name, description || undefined),
    onSuccess: () => {
      setName("");
      setDescription("");
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteProject(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Projects</h1>
        <p className="text-sm text-slate-500">
          Create a project, add documents, and run chunking experiments.
        </p>
      </div>

      <div className="card p-5">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">New project</h2>
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <div className="flex-1">
            <label className="label">Name</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Product docs RAG"
            />
          </div>
          <div className="flex-1">
            <label className="label">Description (optional)</label>
            <input
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What are you evaluating?"
            />
          </div>
          <button className="btn-primary" disabled={!name.trim() || create.isPending}>
            {create.isPending ? <Spinner /> : <Plus className="h-4 w-4" />} Create
          </button>
        </form>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner className="h-6 w-6 text-brand-600" />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects?.map((p) => (
            <div key={p.id} className="card flex flex-col p-5 transition hover:shadow-md">
              <Link href={`/projects/${p.id}`} className="flex-1">
                <h3 className="text-lg font-semibold text-slate-800">{p.name}</h3>
                {p.description && (
                  <p className="mt-1 line-clamp-2 text-sm text-slate-500">{p.description}</p>
                )}
                <div className="mt-4 flex gap-4 text-xs text-slate-500">
                  <span className="flex items-center gap-1">
                    <FileText className="h-3.5 w-3.5" /> {p.file_count} files
                  </span>
                  <span className="flex items-center gap-1">
                    <FlaskConical className="h-3.5 w-3.5" /> {p.run_count} runs
                  </span>
                </div>
              </Link>
              <button
                className="btn-ghost mt-3 self-start text-rose-600 hover:bg-rose-50"
                onClick={() => {
                  if (confirm(`Delete project "${p.name}"?`)) remove.mutate(p.id);
                }}
              >
                <Trash2 className="h-4 w-4" /> Delete
              </button>
            </div>
          ))}
          {projects?.length === 0 && (
            <p className="col-span-full py-8 text-center text-sm text-slate-400">
              No projects yet. Create one above.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
