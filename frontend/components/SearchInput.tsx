"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useSearchStore } from "../lib/store";

interface Props {
  placeholder?: string;
  initialValue?: string;
  autoFocus?: boolean;
}

export function SearchInput({ placeholder = "Search EvidenceLens", initialValue = "", autoFocus }: Props) {
  const router = useRouter();
  const triggerSearch = useSearchStore(s => s.triggerSearch);
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLInputElement>(null);

  // Keep the input in sync when the URL query changes (back/forward navigation)
  useEffect(() => { if (initialValue) setValue(initialValue); }, [initialValue]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault(); ref.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    // flushSync commits the store update before router.push's React transition begins
    flushSync(() => { triggerSearch(value.trim()); });
    router.push(`/search?q=${encodeURIComponent(value.trim())}`);
  }

  return (
    <form role="search" onSubmit={handleSubmit} className="reticle flex items-center gap-2 p-2">
      <span aria-hidden="true" className="reticle-corner tl" />
      <span aria-hidden="true" className="reticle-corner tr" />
      <span aria-hidden="true" className="reticle-corner bl" />
      <span aria-hidden="true" className="reticle-corner br" />

      <svg
        aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        className="ml-2 shrink-0 text-[hsl(var(--accent))]"
      >
        <circle cx="11" cy="11" r="7" />
        <line x1="11" y1="11" x2="11.01" y2="11" />
        <line x1="16.5" y1="16.5" x2="21" y2="21" />
      </svg>

      <label htmlFor="search-q" className="sr-only">Search query</label>
      <input
        id="search-q"
        ref={ref}
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="flex-1 bg-transparent outline-none px-1 py-1.5 font-sans placeholder:text-[hsl(var(--muted))]"
        aria-keyshortcuts="/"
      />
      <button type="submit" className="btn btn-accent px-4 py-1.5 text-sm">
        Search
      </button>
    </form>
  );
}
