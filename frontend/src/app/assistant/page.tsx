"use client";

import Link from "next/link";
import { BookOpen } from "lucide-react";
import { ChatPanel, ABOUT_SUGGESTIONS } from "@/components/chat/ChatPanel";
import { PageHeader } from "@/components/ui/PageHeader";

export default function AssistantPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Ask the docs"
        subtitle="A product assistant grounded in chunklab's own documentation — it embeds your question, retrieves the most relevant doc sections from pgvector, and answers from them (RAG over the docs)."
        actions={
          <Link href="/about" className="btn-secondary">
            <BookOpen className="h-4 w-4" /> About &amp; docs
          </Link>
        }
      />
      <ChatPanel scope="about" suggestions={ABOUT_SUGGESTIONS} placeholder="Ask anything about chunklab…" />
    </div>
  );
}
