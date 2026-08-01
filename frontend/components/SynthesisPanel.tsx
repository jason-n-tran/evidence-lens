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

// Pull the incremental text out of one agent SSE event. The agent relays raw
// provider events, whose shapes differ:
//   - Anthropic: {type:"content_block_delta", data:{delta:{type:"text_delta",text}}}
//   - OpenAI/Groq: {type:"chunk", data:{choices:[{delta:{content}}]}}
// Return "" for any event that carries no visible text (tool calls, metadata).
function extractDelta(ev: any): string {
  if (!ev || typeof ev !== "object") return "";
  if (ev.type === "content_block_delta") {
    const d = ev.data?.delta;
    return typeof d?.text === "string" ? d.text : "";
  }
  if (ev.type === "chunk") {
    const c = ev.data?.choices?.[0]?.delta?.content;
    return typeof c === "string" ? c : "";
  }
  return "";
}

/**
 * BYOK synthesis: stream from the gateway's /llm/synthesize (which proxies to
 * the agent → the user's chosen provider). The user's key never leaves their
 * browser except as a Bearer header to our proxy. `onText` is called with each
 * cumulative output as deltas arrive; resolves with the final text.
 */
async function streamByok(
  opts: { provider: string; key: string; model: string; system: string; query: string; sessionId: string },
  onText: (full: string) => void,
  isStale: () => boolean,
): Promise<string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "authorization": `Bearer ${opts.key}`,
    "x-provider": opts.provider,
  };
  if (opts.model) headers["x-model"] = opts.model;

  const res = await fetch(`${GATEWAY_URL}/llm/synthesize`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      sessionId: opts.sessionId,
      // The agent prepends its own system prompt; we pass ours + the question
      // as the conversation so the numbered-sources context is in-band.
      messages: [
        { role: "user", content: `${opts.system}\n\nQuestion: ${opts.query}` },
      ],
      tools: [],
    }),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`synthesis failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (isStale()) { reader.cancel().catch(() => {}); break; }
    buf += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line.
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      // A frame may carry an `event:` line plus a `data:` line.
      const isError = frame.includes("event: error");
      const dataLine = frame.split("\n").find(l => l.startsWith("data:"));
      if (!dataLine) continue;
      const json = dataLine.slice(5).trim();
      if (!json || json === "{}") continue;
      let ev: any;
      try { ev = JSON.parse(json); } catch { continue; }
      if (isError) throw new Error(ev?.message || "provider error");
      const piece = extractDelta(ev);
      if (piece) { out += piece; onText(out); }
    }
  }
  return out;
}

/** Render model output with [N] citations as clickable /document/{id} links. */
function WithCitations({ text, docs }: { text: string; docs: DocRef[] }) {
  const parts = text.split(/(\[\d+\])/g);
  return (
    <>
      {parts.map((part, i) => {
        const m = part.match(/^\[(\d+)\]$/);
        if (m) {
          const doc = docs[parseInt(m[1]) - 1];
          if (doc?.id) {
            return (
              <Link
                key={i}
                href={`/document?id=${encodeURIComponent(doc.id)}` as any}
                className="text-[hsl(var(--accent))] hover:underline font-semibold"
                title={doc.title}
              >
                {part}
              </Link>
            );
          }
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

export function SynthesisPanel() {
  const query    = useSearchStore(s => s.query);
  const tier     = useByokStore(s => s.tier);
  const provider = useByokStore(s => s.provider);
  const apiKey   = useByokStore(s => s.key);
  const model    = useByokStore(s => s.model);
  const engine   = useWebLLMStore(s => s.engine);

  const [output,  setOutput]  = useState("");
  const [docs,    setDocs]    = useState<DocRef[]>([]);
  const [badge,   setBadge]   = useState("");
  const [running, setRunning] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [open,    setOpen]    = useState(false);
  const genRef = useRef(0);

  // BYOK runs when a key is present; WebLLM runs when its engine is loaded. MCP
  // has no in-page synthesis (the user drives it from an external client).
  const byokReady   = tier === "byok"   && !!apiKey;
  const webllmReady = tier === "webllm" && !!engine;

  useEffect(() => {
    if (!query || (!byokReady && !webllmReady)) {
      setOutput(""); setDocs([]); setBadge(""); setError(null); setRunning(false); setOpen(false);
      return;
    }

    // Cache hit: a completed synthesis for this query already exists (e.g. the
    // user opened a result and hit Back). Restore it instantly instead of
    // re-running the model. Cache is keyed by query only; switching tiers
    // re-runs because the effect re-fires and the cache is checked fresh.
    const cached = useSynthesisCache.getState().get(query);
    if (cached) {
      setDocs(cached.docs);
      setBadge(cached.badge);
      setOutput(cached.output);
      setRunning(false);
      return;
    }

    const gen = ++genRef.current;
    setOutput(""); setDocs([]); setBadge(""); setError(null); setRunning(true); setOpen(false);

    (async () => {
      // 1. Fetch real results from the gateway — no model tool call needed.
      const results = await prefetchResults(query);
      if (genRef.current !== gen) return;
      setDocs(results);
      const badgeText = `search_evidence → ${results.length} result${results.length === 1 ? "" : "s"}`;
      setBadge(badgeText);

      const system = buildPrompt(query, results);
      let buf = "";

      // 2. Generate — either via the visitor's BYOK provider (server-proxied)
      // or the in-browser WebLLM engine. Both stream into `output`.
      if (byokReady) {
        buf = await streamByok(
          { provider, key: apiKey, model, system, query, sessionId: getSessionId() },
          (full) => { if (genRef.current === gen) setOutput(full); },
          () => genRef.current !== gen,
        );
      } else {
        const stream = await engine.chat.completions.create({
          messages: [
            { role: "system", content: system },
            { role: "user",   content: query },
          ],
          stream: true,
          temperature: 0.2,
        });
        for await (const chunk of stream) {
          if (genRef.current !== gen) return;
          const piece = chunk.choices?.[0]?.delta?.content ?? "";
          if (!piece) continue;
          buf += piece;
          setOutput(buf);
        }
      }

      if (genRef.current === gen) {
        setRunning(false);
        // Cache the completed synthesis so navigating back doesn't regenerate.
        // Only cache when results were actually found: a synthesis built on an
        // empty result set (e.g. search was temporarily down) must NOT be
        // cached, or it sticks as "0 results" even after search recovers.
        if (buf && results.length > 0) {
          useSynthesisCache.getState().set(query, { output: buf, docs: results, badge: badgeText });
        }
      }
    })().catch((err: Error) => {
      if (genRef.current !== gen) return;
      setError(err.message);
      setRunning(false);
    });

    return () => { genRef.current++; };
  }, [query, tier, provider, apiKey, model, engine, byokReady, webllmReady]);

  if (!query || tier === "mcp") return null;
  if (tier === "webllm" && !engine) {
    return (
      <div className="rounded border border-[hsl(var(--border))] px-4 py-3 text-sm text-[hsl(var(--muted))]">
        Load the WebLLM model in the right sidebar to enable AI synthesis.
      </div>
    );
  }
  if (tier === "byok" && !apiKey) {
    return (
      <div className="rounded border border-[hsl(var(--border))] px-4 py-3 text-sm text-[hsl(var(--muted))]">
        Add your API key in the right sidebar to enable AI synthesis.
      </div>
    );
  }
  if (!output && !running && !error) return null;

  const hasContent = !!(output || error);

  return (
    <section aria-label="AI synthesis" className="rounded border border-[hsl(var(--border))] text-sm overflow-hidden">

      {/* Header — always visible */}
      <button
        type="button"
        onClick={() => hasContent && setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-[hsl(var(--muted)/0.06)] transition-colors"
        aria-expanded={open}
      >
        <div className="flex flex-wrap items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className="shrink-0 text-[hsl(var(--accent))]" aria-hidden="true">
            <path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5z" />
          </svg>
          <span className="text-xs font-semibold">AI synthesis</span>
          {running && (
            <span aria-live="polite" className="text-xs text-[hsl(var(--muted))] animate-pulse">
              thinking…
            </span>
          )}
          {badge && (
            <span className="text-[10px] font-mono bg-[hsl(var(--muted)/0.15)] text-[hsl(var(--muted))] px-1.5 py-0.5 rounded">
              {badge}
            </span>
          )}
        </div>
        {hasContent && (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            className={`shrink-0 text-[hsl(var(--muted))] transition-transform duration-200 ${open ? "rotate-180" : ""}`}
            aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>

      {/* Collapsed preview — streams in real-time, clamped to 3 lines */}
      {!open && hasContent && (
        <div className="relative px-4 pb-4">
          <p className="evidence line-clamp-3 whitespace-pre-wrap leading-relaxed text-[hsl(var(--muted))] text-sm">
            {error ?? output}
          </p>
          <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-[hsl(var(--background))] to-transparent pointer-events-none" />
        </div>
      )}

      {/* Expanded view */}
      {open && (
        <div className="border-t border-[hsl(var(--border)/0.5)]">
          <div className="evidence px-4 py-3 max-h-72 overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap">
            {error
              ? <span className="text-[hsl(var(--coi))]">{error}</span>
              : <WithCitations text={output} docs={docs} />}
          </div>

          {/* Reference list — only actual db documents with real ids */}
          {docs.length > 0 && (
            <div className="px-4 pb-3 pt-2 border-t border-[hsl(var(--border)/0.4)] space-y-1">
              <p className="text-[10px] font-semibold text-[hsl(var(--muted))] uppercase tracking-wide">
                Sources searched
              </p>
              {docs.map((d, i) => (
                <Link
                  key={d.id}
                  href={`/document?id=${encodeURIComponent(d.id)}` as any}
                  className="flex items-baseline gap-1.5 text-[10px] text-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))] transition-colors group"
                >
                  <span className="font-mono text-[hsl(var(--accent))] shrink-0">[{i + 1}]</span>
                  <span className="truncate group-hover:underline">{d.title}</span>
                  {d.year && <span className="shrink-0 text-[hsl(var(--muted)/0.6)]">{d.year}</span>}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
