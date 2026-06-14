"use client";

import { useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckSquare, FileText, Square, Trash2, Upload, UploadCloud } from "lucide-react";
import { deleteFile, listFiles, uploadFile } from "@/lib/api";
import { logger } from "@/lib/logger";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Progress } from "@/components/ui/Progress";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";

const ACCEPT = ".pdf,.txt,.md,.markdown,.docx,.pptx,.html";

interface UploadItem {
  id: string;
  name: string;
  pct: number;
  error?: string;
}

function fmtSize(b: number | null) {
  if (!b) return "";
  if (b > 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024).toFixed(1)} KB`;
}

export default function FilesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // parsing options (applied to subsequent uploads)
  const [parser, setParser] = useState<"docling" | "fast">("docling");
  const [ocr, setOcr] = useState(true);
  const [tables, setTables] = useState(true);

  const { data: files } = useQuery({
    queryKey: ["files", projectId],
    queryFn: () => listFiles(projectId),
    refetchInterval: (q) =>
      q.state.data?.some((f) => ["uploaded", "parsing"].includes(f.status)) ? 2000 : false,
  });

  async function startUploads(list: File[]) {
    if (!list.length) return;
    logger.info("file.upload.start", { count: list.length });
    const items: UploadItem[] = list.map((f, i) => ({ id: `${Date.now()}-${i}`, name: f.name, pct: 0 }));
    setUploads((u) => [...u, ...items]);
    for (let i = 0; i < list.length; i++) {
      const item = items[i];
      try {
        await uploadFile(
          projectId,
          list[i],
          (pct) => setUploads((u) => u.map((x) => (x.id === item.id ? { ...x, pct } : x))),
          { parser, ocr, tables },
        );
        logger.info("file.uploaded", { name: item.name });
        setUploads((u) => u.filter((x) => x.id !== item.id));
        qc.invalidateQueries({ queryKey: ["files", projectId] });
      } catch (e) {
        logger.error("file.upload.failed", { name: item.name, error: (e as Error).message });
        setUploads((u) => u.map((x) => (x.id === item.id ? { ...x, error: (e as Error).message } : x)));
      }
    }
  }

  const onFiles = (fl: FileList | null) => fl && startUploads(Array.from(fl));

  const remove = useMutation({
    mutationFn: (id: string) => deleteFile(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["files", projectId] }),
  });

  const bulkDelete = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await deleteFile(id);
    },
    onSuccess: (_d, ids) => {
      logger.warn("file.bulk_delete", { count: ids.length });
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["files", projectId] });
    },
  });

  const allIds = files?.map((f) => f.id) ?? [];
  const allSelected = allIds.length > 0 && selected.size === allIds.length;

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(allIds));
  }

  return (
    <div>
      <PageHeader
        title="Files"
        subtitle="Upload documents — parsed with docling, then the original is discarded."
        actions={
          <button className="btn-primary" onClick={() => inputRef.current?.click()}>
            <Upload className="h-4 w-4" /> Upload files
          </button>
        }
      />

      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        accept={ACCEPT}
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {/* parsing options */}
      <div className="card mb-4 flex flex-wrap items-center gap-x-6 gap-y-3 p-4">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Parser</span>
          <div className="flex rounded-lg border border-slate-200 p-0.5">
            {(["docling", "fast"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setParser(p)}
                className={
                  parser === p
                    ? "rounded-md bg-brand-600 px-3 py-1 text-xs font-medium text-white"
                    : "px-3 py-1 text-xs text-slate-600 hover:text-slate-900"
                }
              >
                {p === "docling" ? "Docling (rich)" : "Fast (text only)"}
              </button>
            ))}
          </div>
        </div>
        {parser === "docling" ? (
          <>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" className="accent-brand-600" checked={ocr} onChange={(e) => setOcr(e.target.checked)} />
              OCR (scanned PDFs)
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" className="accent-brand-600" checked={tables} onChange={(e) => setTables(e.target.checked)} />
              Extract tables
            </label>
            <span className="text-xs text-slate-400">Turn these off for much faster PDF parsing.</span>
          </>
        ) : (
          <span className="text-xs text-slate-400">Fast text extraction (pypdf / plain text) — no models, instant.</span>
        )}
      </div>

      {/* dropzone */}
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          onFiles(e.dataTransfer.files);
        }}
        className={`mb-6 flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition ${
          dragging ? "border-brand-500 bg-brand-50/60" : "border-slate-300 bg-white/60 hover:border-brand-400 hover:bg-slate-50"
        }`}
      >
        <span className="mb-3 rounded-2xl bg-brand-50 p-3 text-brand-600"><UploadCloud className="h-7 w-7" /></span>
        <p className="text-sm font-medium text-slate-700">Drag &amp; drop files here, or click to browse</p>
        <p className="mt-1 text-xs text-slate-400">PDF, Markdown, TXT, DOCX, PPTX, HTML · multiple files supported</p>
      </div>

      {uploads.length > 0 && (
        <div className="card mb-6 space-y-3 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Uploading {uploads.length} file{uploads.length > 1 ? "s" : ""}
          </p>
          {uploads.map((u) => (
            <div key={u.id} className="flex items-center gap-3">
              <FileText className="h-4 w-4 shrink-0 text-slate-400" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="truncate text-slate-600">{u.name}</span>
                  <span className={u.error ? "text-rose-600" : "text-slate-400"}>{u.error ? u.error : `${Math.round(u.pct * 100)}%`}</span>
                </div>
                <Progress value={u.error ? 0 : u.pct} className="mt-1" />
              </div>
            </div>
          ))}
        </div>
      )}

      {files && files.length > 0 ? (
        <div className="card overflow-hidden">
          {/* toolbar: select-all + bulk actions */}
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-2.5">
            <button onClick={toggleAll} className="flex items-center gap-2 text-sm text-slate-600 hover:text-slate-900">
              {allSelected ? <CheckSquare className="h-4 w-4 text-brand-600" /> : <Square className="h-4 w-4 text-slate-400" />}
              {selected.size > 0 ? `${selected.size} selected` : "Select all"}
            </button>
            {selected.size > 0 && (
              <button
                className="btn-danger btn-sm"
                disabled={bulkDelete.isPending}
                onClick={() => {
                  if (confirm(`Delete ${selected.size} file(s)?`)) bulkDelete.mutate([...selected]);
                }}
              >
                {bulkDelete.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />} Delete selected
              </button>
            )}
          </div>

          <div className="divide-y divide-slate-100">
            {files.map((f) => {
              const isSel = selected.has(f.id);
              return (
                <div key={f.id} className={`flex items-center justify-between px-5 py-3.5 ${isSel ? "bg-brand-50/40" : ""}`}>
                  <div className="flex min-w-0 items-center gap-3">
                    <button onClick={() => toggle(f.id)} className="shrink-0">
                      {isSel ? <CheckSquare className="h-4 w-4 text-brand-600" /> : <Square className="h-4 w-4 text-slate-300 hover:text-slate-500" />}
                    </button>
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500"><FileText className="h-4 w-4" /></span>
                    <div className="min-w-0">
                      <p className="truncate font-medium text-slate-800">{f.filename}</p>
                      <p className="text-xs text-slate-400">
                        {fmtSize(f.size_bytes)}
                        {f.parser_used ? ` · parsed by ${f.parser_used}` : ""}
                        {f.error ? ` · ${f.error}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge status={f.status}>
                      {["parsing", "uploaded"].includes(f.status) && <Spinner className="h-3 w-3" />}
                      {f.status}
                    </Badge>
                    <button className="text-slate-300 transition hover:text-rose-600" onClick={() => remove.mutate(f.id)} title="Remove file">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        uploads.length === 0 && (
          <EmptyState icon={FileText} title="No files yet" description="Upload PDFs, markdown, or text to start chunking experiments." />
        )
      )}
    </div>
  );
}
