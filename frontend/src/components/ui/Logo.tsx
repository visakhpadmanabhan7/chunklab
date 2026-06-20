function ChunkMark({ size = 18 }: { size?: number }) {
  // Three stacked, fading bars — a document split into chunks.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4.5" width="16" height="4" rx="2" fill="white" />
      <rect x="4" y="10" width="10.5" height="4" rx="2" fill="white" fillOpacity="0.85" />
      <rect x="4" y="15.5" width="13.5" height="4" rx="2" fill="white" fillOpacity="0.68" />
    </svg>
  );
}

export function Logo({
  size = "md",
  onDark = false,
}: {
  size?: "sm" | "md" | "lg";
  onDark?: boolean;
}) {
  const d = {
    sm: { tile: "h-8 w-8 rounded-lg", icon: 16, text: "text-base" },
    md: { tile: "h-9 w-9 rounded-xl", icon: 18, text: "text-lg" },
    lg: { tile: "h-12 w-12 rounded-2xl", icon: 24, text: "text-2xl" },
  }[size];
  const tileBg = onDark
    ? "bg-white/15 ring-1 ring-white/25"
    : "bg-gradient-to-br from-brand-500 to-sky-500 shadow-sm shadow-brand-600/30";
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className={`flex items-center justify-center ${d.tile} ${tileBg}`}>
        <ChunkMark size={d.icon} />
      </span>
      <span className={`font-bold tracking-tight ${d.text} ${onDark ? "text-white" : "text-slate-900"}`}>
        Chunk
        <span
          className={
            onDark
              ? "text-white/85"
              : "bg-gradient-to-r from-brand-600 to-sky-500 bg-clip-text text-transparent"
          }
        >
          Lab
        </span>
      </span>
    </span>
  );
}
