"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ResultCard } from "./ResultCard";
import { useSearchStore } from "../lib/store";
import { getVariant, getSessionId, logClick } from "../lib/session";

type SortMode = "relevance" | "most_recent" | "most_cited" | "most_influential" | undefined;

interface Result {
  document: any;
  finalScore: number;
  breakdown: any;
}

function applySort(results: Result[], mode: SortMode): Result[] {
  if (mode === "most_cited") {
    return [...results].sort((a, b) =>
      (Number(b.document.citation_count) || 0) - (Number(a.document.citation_count) || 0)
    );
  }
  if (mode === "most_influential") {
    return [...results].sort((a, b) =>
      (Number(b.document.citation_pagerank) || 0) - (Number(a.document.citation_pagerank) || 0)
    );
  }
  if (mode === "most_recent") {
    return [...results].sort((a, b) =>
      (b.document.published_at ?? "").localeCompare(a.document.published_at ?? "")
    );
  }
  return results;
}

/**
 * Subscribes to /ws and renders streamed search.partial / search.final
 * frames into an ARIA live region for screen-reader announcements as
 * each wave arrives.
 *
 * Spec §8.4 keyboard navigation:
 *   j / k     move focus between results
 *   Enter     open the focused result (router.push to /document/[id])
 *   Esc       blur focused result
 *   /         focus search input (handled in SearchInput)
 *   f         dispatch CustomEvent('evidencelens:toggle-facets') so
 *             FacetSidebar can listen and toggle without a context
 *   ?         handled by KeyboardHelp
 */
export function ResultsStream() {
  const router = useRouter();
  const query = useSearchStore(s => s.query);
  const searchVersion = useSearchStore(s => s.searchVersion);
  const [results, setResults] = useState<Result[]>([]);
  const [done, setDone] = useState(false);
  const [focused, setFocused] = useState<number>(-1);
  const itemRefs = useRef<Array<HTMLLIElement | null>>([]);
  // queryId groups all clicks from one search; variant tags them for A/B.
  const queryIdRef = useRef<string>("");
  const variantRef = useRef<string>("control");

  // Resolve this session's A/B variant once.
  useEffect(() => { getVariant().then(v => { variantRef.current = v; }); }, []);

  // Log a result click (best-effort) so analytics + LTR training have data.
  function recordClick(position: number, docId: string) {
    if (!docId) return;
    logClick({
      queryId: queryIdRef.current,
      queryText: query,
      variant: variantRef.current,
      docId,
      position,
      resultSetSize: results.length,
    });
  }

  useEffect(() => {
    if (!query) return;
    // Read at effect time — setFilter/toggleStudyType bump searchVersion, so this always runs fresh
    const { filters } = useSearchStore.getState();
    const sortMode = filters.sortMode as SortMode;
    setResults([]);
    setDone(false);
    setFocused(-1);
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080/ws";
    const ws = new WebSocket(wsUrl, ["evidencelens.v1"]);
    const id = `q-${Date.now()}`;
    queryIdRef.current = id;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        event: "search",
        data: { id, query, topK: 50, filters, variant: variantRef.current, sessionId: getSessionId() },
      }));
    };
    ws.onmessage = (e) => {
      try {
        const f = JSON.parse(e.data);
        // Always handle errors regardless of id (gateway may send without id).
        if (f.type === "error") { setDone(true); return; }
        if (f.id !== id) return;
        if (f.type === "search.partial" || f.type === "search.final") {
          setResults(prev => {
            const next = f.wave === 1 ? f.results : [...prev, ...f.results];
            return f.isFinal ? applySort(next, sortMode) : next;
          });
          if (f.isFinal) setDone(true);
        }
      } catch { /* ignore */ }
    };
    ws.onerror = () => setDone(true);
    return () => ws.close();
  }, [query, searchVersion]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      const editing = tag === "input" || tag === "textarea" || (document.activeElement as any)?.isContentEditable;
      if (editing) return;
      if (e.key === "j") {
        e.preventDefault();
        setFocused(i => {
          const next = Math.min(results.length - 1, i + 1);
          itemRefs.current[next]?.focus();
          return next;
        });
      } else if (e.key === "k") {
        e.preventDefault();
        setFocused(i => {
          const next = Math.max(0, i - 1);
          itemRefs.current[next]?.focus();
          return next;
        });
      } else if (e.key === "Enter" && focused >= 0 && results[focused]) {
        e.preventDefault();
        const id = results[focused].document?.id;
        if (id) {
          recordClick(focused, id);
          router.push(`/document?id=${encodeURIComponent(id)}` as any);
        }
      } else if (e.key === "Escape") {
        if (focused >= 0) {
          itemRefs.current[focused]?.blur();
          setFocused(-1);
        }
      } else if (e.key === "f") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("evidencelens:toggle-facets"));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [results, focused, router]);

  if (!query) return <p className="evidence text-[hsl(var(--muted))]">Type a query above to begin.</p>;

  return (
    <div role="region" aria-label="Search results" aria-busy={!done}>
      <div role="status" aria-live="polite" className="sr-only">
        {done ? `${results.length} results loaded` : `Loading wave ${results.length === 0 ? 1 : ""}…`}
      </div>
      {!done && results.length === 0 && (
        <p className="eyebrow animate-pulse">Scanning sources…</p>
      )}
      <ul className="space-y-3">
        {results.map((r, i) => (
          <ResultCard
            key={r.document.id ?? i}
            result={r}
            focused={i === focused}
            onSelect={() => recordClick(i, r.document?.id)}
            ref={(el) => { itemRefs.current[i] = el; }}
          />
        ))}
      </ul>
      {results.length === 0 && done && (
        <p className="evidence text-[hsl(var(--muted))]">No results. Try broader terms or adjust facet filters.</p>
      )}
    </div>
  );
}
