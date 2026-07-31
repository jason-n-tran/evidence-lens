"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { SearchInput } from "../../components/SearchInput";
import { ResultsStream } from "../../components/ResultsStream";
import { SynthesisPanel } from "../../components/SynthesisPanel";
import { FacetSidebar } from "../../components/FacetSidebar";
import { TierPicker } from "../../components/TierPicker";
import { ShareButton } from "../../components/ShareButton";
import { useSearchStore, paramsToFilters } from "../../lib/store";

function SearchPageBody() {
  const params = useSearchParams();
  const q = params.get("q") ?? "";
  const setQuery = useSearchStore(s => s.setQuery);
  const setFilters = useSearchStore(s => s.setFilters);

  // Hydrate query + filters from the URL so shared/bookmarked links restore the
  // full search state. `search` re-runs this when the URL changes.
  const search = params.toString();
  useEffect(() => {
    setFilters(paramsToFilters(new URLSearchParams(search)));
    setQuery(q);
  }, [search, q, setQuery, setFilters]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 grid grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)_320px] gap-8">
      <FacetSidebar />
      <div className="space-y-5">
        <SearchInput initialValue={q} />
        <div className="flex items-center justify-between">
          {q && <p className="eyebrow truncate">Results for <span className="text-[hsl(var(--accent))]">{q}</span></p>}
          <ShareButton />
        </div>
        <SynthesisPanel />
        <ResultsStream />
      </div>
      <aside aria-label="Tier picker" className="space-y-4">
        <TierPicker />
      </aside>
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<div role="status" aria-live="polite">Loading…</div>}>
      <SearchPageBody />
    </Suspense>
  );
}
