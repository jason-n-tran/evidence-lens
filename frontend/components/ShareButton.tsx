"use client";

import { useState } from "react";
import { useSearchStore, filtersToParams } from "../lib/store";

// Copies a shareable URL (current query + all active filters) to the clipboard.
// Pairs with the search page hydrating filters from the URL on load, so the
// recipient sees the same results.
export function ShareButton() {
  const query = useSearchStore(s => s.query);
  const [copied, setCopied] = useState(false);

  async function copy() {
    const { filters } = useSearchStore.getState();
    const params = filtersToParams(query, filters);
    const url = `${window.location.origin}/search?${params.toString()}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (e.g. insecure context) — select-fallback via prompt.
      window.prompt("Copy this link:", url);
    }
  }

  if (!query) return null;

  return (
    <button
      type="button"
      onClick={copy}
      className="eyebrow shrink-0 text-[hsl(var(--accent))] hover:opacity-70"
      aria-label="Copy a shareable link to these search results"
    >
      {copied ? "✓ Link copied" : "Share results"}
    </button>
  );
}
