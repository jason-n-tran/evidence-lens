import { Injectable, Logger } from "@nestjs/common";

export interface SearchFilters {
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

/** Convert camelCase frontend filters to the snake_case dict the Python scorer expects. */
function toScorerFilters(f: SearchFilters | undefined): Record<string, unknown> | undefined {
  if (!f) return undefined;
  const out: Record<string, unknown> = {};
  if (f.studyTypes?.length)             out["study_types"] = f.studyTypes;
  if (f.publishedYearMin != null)       out["published_year_min"] = f.publishedYearMin;
  if (f.publishedYearMax != null)       out["published_year_max"] = f.publishedYearMax;
  if (f.meshTerms?.length)             out["mesh_terms"] = f.meshTerms;
  if (f.sources?.length)               out["sources"] = f.sources;
  if (f.licenses?.length)              out["licenses"] = f.licenses;
  if (f.onlyWithCoi)                   out["only_with_coi"] = true;
  if (f.onlyWithFullText)              out["only_with_full_text"] = true;
  if (f.excludePredatoryJournals)      out["exclude_predatory_journals"] = true;
  if (f.sortMode && f.sortMode !== "relevance") out["sort_mode"] = f.sortMode;
  return Object.keys(out).length ? out : undefined;
}

export interface ScoredResult {
  document: any;
  final_score: number;
  finalScore?: number; // alias populated below
  breakdown: any;
}

export interface SearchResult {
  query: string;
  results: ScoredResult[];
  totalEstimated: number;
  variant?: string;
  elapsedMs: number;
}

export type WaveCallback = (
  wave: number,
  isFinal: boolean,
  results: ScoredResult[],
  elapsedMs: number,
) => void | Promise<void>;

const SCORER_URL = process.env.SCORER_HTTP_URL ?? "http://scorer:8090";

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  /**
   * Synchronous search: drains the SSE stream from scorer-pool, returns
   * the final wave's results.
   */
  async search(
    query: string,
    filters?: SearchFilters,
    topK = 50,
    variant?: string,
    sessionId?: string,
  ): Promise<SearchResult> {
    const start = Date.now();
    const accumulated: ScoredResult[] = [];
    const seen = new Set<string>();
    let totalElapsed = 0;
    try {
      await this.streamFromScorer(query, filters, topK, (wave, isFinal, results, elapsedMs) => {
        // Merge each wave into the accumulated set (waves are additive slices).
        for (const r of results) {
          const id = r.document?.id ?? r.document?.canonical_id ?? JSON.stringify(r.document).slice(0, 64);
          if (!seen.has(id)) {
            seen.add(id);
            accumulated.push(r);
          }
        }
        totalElapsed = elapsedMs;
      });
    } catch (e) {
      this.logger.warn(`search upstream error: ${(e as Error).message}`);
    }
    // Sort by final_score descending; fall back to bm25.
    accumulated.sort((a, b) => {
      const sa = (b.final_score || b.breakdown?.bm25 || 0);
      const sb = (a.final_score || a.breakdown?.bm25 || 0);
      return sa - sb;
    });
    return {
      query,
      results: accumulated.slice(0, topK),
      totalEstimated: accumulated.length,
      variant,
      elapsedMs: totalElapsed || Date.now() - start,
    };
  }

  /**
   * Streamed search: invoke `cb` for each wave as it arrives.
   * Used by the WebSocket gateway to forward wave frames downstream.
   */
  async streamFromScorer(
    query: string,
    filters: SearchFilters | undefined,
    topK: number,
    cb: WaveCallback,
  ): Promise<void> {
    const start = Date.now();
    const res = await fetch(`${SCORER_URL}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, filters: toScorerFilters(filters), top_k: topK }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`scorer upstream ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE frames are separated by blank line.
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const dataLine = frame.split("\n").find(l => l.startsWith("data:"));
        if (!dataLine) continue;
        const json = dataLine.slice(5).trim();
        if (json === "{}") continue; // sentinel
        try {
          const obj = JSON.parse(json);
          if (obj.type === "search.partial" || obj.type === "search.final") {
            await cb(obj.wave, obj.isFinal, obj.results ?? [], Date.now() - start);
          }
        } catch { /* malformed frame, skip */ }
      }
    }
  }
}
