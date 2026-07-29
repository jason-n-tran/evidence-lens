"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchStore, useByokStore, useWebLLMStore, useSynthesisCache } from "../lib/store";
import { getSessionId } from "../lib/session";

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8080";

interface DocRef {
  id: string;
  title: string;
  studyType?: string;
  year?: string;
  canonicalUrl?: string;
}

async function prefetchResults(query: string): Promise<DocRef[]> {
  try {
    const res = await fetch(`${GATEWAY_URL}/api/tool/search_evidence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, top_k: 5 }),
    });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data?.results ?? []).slice(0, 5).map((item: any) => {
      const doc = item.document ?? item;
      return {
        id:           String(doc.id ?? ""),
        title:        String(doc.title ?? "Untitled"),
        studyType:    doc.study_type  ?? doc.studyType  ?? undefined,
        year:         (doc.published_at ?? doc.publishedAt ?? "").slice(0, 4) || undefined,
        canonicalUrl: doc.canonical_url ?? doc.canonicalUrl ?? undefined,
      };
    }).filter((d: DocRef) => d.id);
  } catch {
    return [];
  }
}

function buildPrompt(query: string, docs: DocRef[]): string {
  const list = docs.length === 0
    ? "No documents were found in the database for this query."
    : docs.map((d, i) =>
        `[${i + 1}] "${d.title}" — ${d.studyType ?? "study type unknown"}, ${d.year ?? "year unknown"} (id:${d.id})`
      ).join("\n");

  return [
    "You are EvidenceLens, an evidence-based biomedical assistant. This is NOT medical advice.",
    "",
    `Write a concise 2-paragraph synthesis answering: "${query}"`,
    "You MUST base your answer only on the numbered sources below.",
    "Cite sources inline using [1], [2], etc. matching the list exactly.",
    "If the list is empty or no source is relevant, state that directly. Do NOT invent studies or citations.",
    "",
    "Sources:",
    list,
  ].join("\n");
}
