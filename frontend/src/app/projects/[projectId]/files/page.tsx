"use client";

import { useRef } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, Upload } from "lucide-react";
import { deleteFile, listFiles, uploadFile } from "@/lib/api";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";

export default function FilesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: files } = useQuery({
    queryKey: ["files", projectId],
    queryFn: () => listFiles(projectId),
    refetchInterval: (q) =>
      q.state.data?.some((f) => ["uploaded", "parsing"].includes(f.status)) ? 2000 : false,
  });

  const upload = useMutation({
    mutationFn: (file: File) => uploadFile(projectId, file),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["files", projectId] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteFile(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["files", projectId] }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Files</h1>
        <button className="btn-primary" onClick={() => inputRef.current?.click()} disabled={upload.isPending}>
          {upload.isPending ? <Spinner /> : <Upload className="h-4 w-4" />} Upload
        </button>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          accept=".pdf,.txt,.md,.markdown,.docx,.pptx,.html"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate(file);
            e.target.value = "";
          }}
        />
      </div>

      <div className="card divide-y divide-slate-100">
        {files?.map((f) => (
          <div key={f.id} className="flex items-center justify-between px-5 py-3">
            <div className="min-w-0">
              <p className="truncate font-medium">{f.filename}</p>
              <p className="text-xs text-slate-500">
                {f.size_bytes ? `${(f.size_bytes / 1024).toFixed(1)} KB` : ""}
                {f.parser_used ? ` · parsed by ${f.parser_used}` : ""}
                {f.error ? ` · ${f.error}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Badge status={f.status}>{f.status}</Badge>
              <button
                className="text-slate-400 hover:text-rose-600"
                onClick={() => remove.mutate(f.id)}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
        {files?.length === 0 && (
          <p className="px-5 py-8 text-center text-sm text-slate-400">
            No files yet. Upload a PDF, markdown, or text file to begin.
          </p>
        )}
      </div>
    </div>
  );
}
