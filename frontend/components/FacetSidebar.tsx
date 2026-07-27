"use client";

import { useEffect, useState } from "react";
import { useSearchStore } from "../lib/store";

// Fallback list used only if the /api/facets call fails. Normally the study-type
// options are driven by what's actually in the index (with counts).
const STUDY_TYPES_FALLBACK = ["RCT", "META_ANALYSIS", "SYSTEMATIC_REVIEW", "OBSERVATIONAL", "PREPRINT", "REGULATORY", "GUIDELINE"];
const SORT_MODES = [
  { id: "relevance",        label: "Relevance" },
  { id: "most_recent",      label: "Most recent" },
  { id: "most_cited",       label: "Most cited" },
  { id: "most_influential", label: "Most influential" },
];
const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8080";

type FacetValue = { value: string; count: number };

export function FacetSidebar() {
  const { filters, toggleStudyType, setFilter } = useSearchStore();
  const [open, setOpen] = useState(true);
  const [studyFacets, setStudyFacets] = useState<FacetValue[] | null>(null);
  const [meshFacets, setMeshFacets] = useState<FacetValue[]>([]);

  // Load the facets actually present in the index (with counts).
  // STUDY_TYPE_UNSPECIFIED/OTHER are dropped — they're not useful filters.
  useEffect(() => {
    let cancelled = false;
    fetch(`${GATEWAY_URL}/api/facets`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((d: { studyTypes?: FacetValue[]; meshTerms?: FacetValue[] }) => {
        if (cancelled) return;
        const fv = (d.studyTypes ?? []).filter(
          f => f.value && f.value !== "OTHER" && f.value !== "STUDY_TYPE_UNSPECIFIED",
        );
        setStudyFacets(fv);
        setMeshFacets((d.meshTerms ?? []).filter(f => f.value));
      })
      .catch(() => { if (!cancelled) setStudyFacets(null); });
    return () => { cancelled = true; };
  }, []);

  // Toggle a value within an array-valued filter (used for mesh_terms).
  function toggleArrayFilter(key: "meshTerms", value: string) {
    const cur = filters[key] ?? [];
    const next = cur.includes(value) ? cur.filter(v => v !== value) : [...cur, value];
    setFilter(key, next.length ? next : undefined);
  }

  // Keyboard shortcut `f` (handled in ResultsStream) dispatches this event.
  useEffect(() => {
    function onToggle() { setOpen(v => !v); }
    window.addEventListener("evidencelens:toggle-facets", onToggle as EventListener);
    return () => window.removeEventListener("evidencelens:toggle-facets", onToggle as EventListener);
  }, []);

  // Dynamic options when the facet call succeeded and returned values;
  // otherwise fall back to the static list (shown without counts).
  const studyOptions: FacetValue[] = (studyFacets && studyFacets.length > 0)
    ? studyFacets
    : STUDY_TYPES_FALLBACK.map(value => ({ value, count: -1 }));

  if (!open) {
    return (
      <aside aria-label="Filters" className="text-sm">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="eyebrow text-[hsl(var(--accent))] hover:opacity-70"
        >
          Show filters (f)
        </button>
      </aside>
    );
  }

  return (
    <aside aria-label="Filters" className="space-y-5 text-sm">
      <div className="flex items-center justify-between">
        <h2 className="eyebrow">Filters</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Hide filters (f)"
          className="eyebrow text-[hsl(var(--muted))] hover:text-[hsl(var(--accent))]"
        >
          hide (f)
        </button>
      </div>

      <fieldset>
        <legend className="eyebrow mb-1.5">Sort by</legend>
        <select
          value={filters.sortMode ?? "relevance"}
          onChange={(e) => setFilter("sortMode", e.target.value as any)}
          className="w-full panel-quiet px-2 py-1.5 bg-[hsl(var(--panel))] text-[hsl(var(--ink))]"
        >
          {SORT_MODES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </fieldset>

      <fieldset>
        <legend className="eyebrow mb-1.5">Study type</legend>
        <div className="space-y-0.5">
          {studyOptions.map(({ value, count }) => (
            <label key={value} className="flex items-center gap-2 py-0.5 cursor-pointer hover:text-[hsl(var(--accent))]">
              <input
                type="checkbox"
                checked={filters.studyTypes?.includes(value) ?? false}
                onChange={() => toggleStudyType(value)}
                className="accent-[hsl(var(--accent))]"
              />
              <span className="flex-1">{value.replaceAll("_", " ").toLowerCase()}</span>
              {count >= 0 && <span className="data text-xs text-[hsl(var(--muted))]">{count}</span>}
            </label>
          ))}
        </div>
      </fieldset>

      {meshFacets.length > 0 && (
        <fieldset>
          <legend className="eyebrow mb-1.5">MeSH topic</legend>
          <div className="max-h-48 overflow-y-auto space-y-0.5">
            {meshFacets.map(({ value, count }) => (
              <label key={value} className="flex items-center gap-2 py-0.5 cursor-pointer hover:text-[hsl(var(--accent))]">
                <input
                  type="checkbox"
                  checked={filters.meshTerms?.includes(value) ?? false}
                  onChange={() => toggleArrayFilter("meshTerms", value)}
                  className="accent-[hsl(var(--accent))]"
                />
                <span className="flex-1">{value}</span>
                <span className="data text-xs text-[hsl(var(--muted))]">{count}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <fieldset>
        <legend className="eyebrow mb-1.5">Year</legend>
        <div className="flex items-center gap-2">
          <input
            type="number" placeholder="from" min="1900" max="2100"
            className="w-20 panel-quiet data px-2 py-1 bg-[hsl(var(--panel))] text-[hsl(var(--ink))]"
            value={filters.publishedYearMin ?? ""}
            onChange={(e) => setFilter("publishedYearMin", e.target.value ? parseInt(e.target.value, 10) : undefined)}
          />
          <span className="text-[hsl(var(--muted))]">–</span>
          <input
            type="number" placeholder="to" min="1900" max="2100"
            className="w-20 panel-quiet data px-2 py-1 bg-[hsl(var(--panel))] text-[hsl(var(--ink))]"
            value={filters.publishedYearMax ?? ""}
            onChange={(e) => setFilter("publishedYearMax", e.target.value ? parseInt(e.target.value, 10) : undefined)}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend className="eyebrow mb-1.5">Quality</legend>
        <label className="flex items-center gap-2 py-0.5 cursor-pointer hover:text-[hsl(var(--accent))]">
          <input
            type="checkbox" checked={!!filters.onlyWithFullText}
            onChange={(e) => setFilter("onlyWithFullText", e.target.checked)}
            className="accent-[hsl(var(--accent))]"
          />
          full text available
        </label>
        {/* "exclude predatory journals" is hidden until a trusted ISSN
            blocklist is loaded (config/predatory_issns.txt). Without one the
            filter is a no-op, so showing it would mislead. Re-add this label
            once a curated ISSN source (e.g. Cabells) is in place. */}
        <label className="flex items-center gap-2 py-0.5 cursor-pointer hover:text-[hsl(var(--accent))]">
          <input
            type="checkbox" checked={!!filters.onlyWithCoi}
            onChange={(e) => setFilter("onlyWithCoi", e.target.checked)}
            className="accent-[hsl(var(--accent))]"
          />
          only with COI
        </label>
      </fieldset>
    </aside>
  );
}
