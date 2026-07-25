import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SearchFilters {
  studyTypes?: string[];
  publishedYearMin?: number;
  publishedYearMax?: number;
  meshTerms?: string[];
  sources?: string[];
  licenses?: string[];
  onlyWithCoi?: boolean;
  onlyWithFullText?: boolean;
  excludePredatoryJournals?: boolean;
  sortMode?: "relevance" | "most_recent" | "most_cited" | "most_influential";
}

interface SearchState {
  query: string;
  filters: SearchFilters;
  searchVersion: number;
  setQuery: (q: string) => void;
  triggerSearch: (q: string) => void;
  toggleStudyType: (t: string) => void;
  setFilter: <K extends keyof SearchFilters>(k: K, v: SearchFilters[K]) => void;
  setFilters: (f: SearchFilters) => void;
}

export const useSearchStore = create<SearchState>()((set) => ({
  query: "",
  filters: {},
  searchVersion: 0,
  setQuery: (q) => set({ query: q }),
  triggerSearch: (q) => set((s) => ({ query: q, searchVersion: s.searchVersion + 1 })),
  toggleStudyType: (t) => set((s) => {
    const cur = s.filters.studyTypes ?? [];
    const next = cur.includes(t) ? cur.filter(x => x !== t) : [...cur, t];
    return { filters: { ...s.filters, studyTypes: next.length ? next : undefined }, searchVersion: s.searchVersion + 1 };
  }),
  setFilter: (k, v) => set((s) => ({ filters: { ...s.filters, [k]: v }, searchVersion: s.searchVersion + 1 })),
  // Replace the whole filter set (used when hydrating from a shared URL).
  setFilters: (f) => set((s) => ({ filters: f, searchVersion: s.searchVersion + 1 })),
}));

// ---- Shareable-URL serialization ----
// Encode query + filters into URLSearchParams so a search is shareable/bookmark-
// able, and decode them back. Array filters are comma-joined; booleans are "1".
export function filtersToParams(query: string, f: SearchFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (query) p.set("q", query);
  if (f.studyTypes?.length) p.set("study", f.studyTypes.join(","));
  if (f.meshTerms?.length) p.set("mesh", f.meshTerms.join(","));
  if (f.sources?.length) p.set("src", f.sources.join(","));
  if (f.publishedYearMin != null) p.set("ymin", String(f.publishedYearMin));
  if (f.publishedYearMax != null) p.set("ymax", String(f.publishedYearMax));
  if (f.onlyWithCoi) p.set("coi", "1");
  if (f.onlyWithFullText) p.set("ft", "1");
  if (f.excludePredatoryJournals) p.set("nopred", "1");
  if (f.sortMode && f.sortMode !== "relevance") p.set("sort", f.sortMode);
  return p;
}

export function paramsToFilters(p: URLSearchParams): SearchFilters {
  const f: SearchFilters = {};
  const csv = (k: string) => p.get(k)?.split(",").map(s => s.trim()).filter(Boolean);
  if (csv("study")) f.studyTypes = csv("study");
  if (csv("mesh")) f.meshTerms = csv("mesh");
  if (csv("src")) f.sources = csv("src");
  if (p.get("ymin")) f.publishedYearMin = parseInt(p.get("ymin")!, 10);
  if (p.get("ymax")) f.publishedYearMax = parseInt(p.get("ymax")!, 10);
  if (p.get("coi") === "1") f.onlyWithCoi = true;
  if (p.get("ft") === "1") f.onlyWithFullText = true;
  if (p.get("nopred") === "1") f.excludePredatoryJournals = true;
  const sort = p.get("sort");
  if (sort === "most_recent" || sort === "most_cited" || sort === "most_influential") f.sortMode = sort;
  return f;
}

interface WebLLMState {
  engine: any;
  setEngine: (e: any) => void;
}

export const useWebLLMStore = create<WebLLMState>()((set) => ({
  engine: null,
  setEngine: (e) => set({ engine: e }),
}));

// ---- AI synthesis cache ----
// The SynthesisPanel runs an LLM generation per query. Without caching, every
// navigation back to the search page (e.g. open a result, hit Back) remounts
// the panel and regenerates the same synthesis from scratch. Cache completed
// syntheses by query so back/forward is instant. Persisted to sessionStorage:
// survives in-session navigation but doesn't accumulate across sessions (and a
// new search session starts fresh). Only COMPLETED generations are stored.
interface SynthesisEntry { output: string; docs: any[]; badge: string }
interface SynthesisCacheState {
  entries: Record<string, SynthesisEntry>;
  get: (query: string) => SynthesisEntry | undefined;
  set: (query: string, entry: SynthesisEntry) => void;
}

export const useSynthesisCache = create<SynthesisCacheState>()(
  persist(
    (set, get) => ({
      entries: {},
      get: (query) => get().entries[query.trim().toLowerCase()],
      set: (query, entry) =>
        set((s) => ({ entries: { ...s.entries, [query.trim().toLowerCase()]: entry } })),
    }),
    {
      name: "evidencelens-synthesis",
      // sessionStorage so the cache is per-tab-session, not forever.
      storage: typeof window !== "undefined"
        ? {
            getItem: (n) => { const v = sessionStorage.getItem(n); return v ? JSON.parse(v) : null; },
            setItem: (n, v) => sessionStorage.setItem(n, JSON.stringify(v)),
            removeItem: (n) => sessionStorage.removeItem(n),
          }
        : undefined,
    },
  ),
);

interface ByokState {
  tier: "byok" | "mcp" | "webllm";
  provider: "anthropic" | "openai" | "groq";
  key: string;
  // Empty string = "use the provider's default model" (the agent picks it).
  // Set when the user chooses a specific model in the picker.
  model: string;
  setTier: (t: ByokState["tier"]) => void;
  setProvider: (p: ByokState["provider"]) => void;
  setKey: (k: string) => void;
  setModel: (m: string) => void;
}

export const useByokStore = create<ByokState>()(
  persist(
    (set) => ({
      tier: "webllm",
      provider: "anthropic",
      key: "",
      model: "",
      setTier: (t) => set({ tier: t }),
      // Changing provider resets the model — a model id is provider-specific.
      setProvider: (p) => set({ provider: p, model: "" }),
      setKey: (k) => set({ key: k }),
      setModel: (m) => set({ model: m }),
    }),
    { name: "evidencelens-byok" },
  ),
);
