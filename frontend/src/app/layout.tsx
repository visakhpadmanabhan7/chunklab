import type { Metadata } from "next";
import Link from "next/link";
import { FlaskConical } from "lucide-react";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "chunklab",
  description: "Evaluate and compare text-chunking strategies for RAG",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/80 backdrop-blur">
            <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
              <Link href="/projects" className="flex items-center gap-2 font-semibold">
                <FlaskConical className="h-5 w-5 text-brand-600" />
                <span>chunklab</span>
              </Link>
              <span className="text-xs text-slate-400">chunking experiment evaluator</span>
            </div>
          </header>
          <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
