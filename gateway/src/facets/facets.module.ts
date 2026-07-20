import { Controller, Get, HttpException, HttpStatus, Module } from "@nestjs/common";
import { CacheService } from "../cache/cache.module.js";

const MEILI_URL = process.env.MEILI_URL ?? "http://meilisearch:7700";
const MEILI_KEY = process.env.MEILI_KEY ?? "";
// Facet distribution changes only as the index grows (minutes-to-hours scale),
// but this endpoint is hit on every search-page load. Cache it briefly.
const FACETS_TTL_SEC = Number(process.env.FACETS_CACHE_TTL_SEC ?? 120);

// Exposes the facet values actually present in the index (with counts) so the
// frontend filter sidebar can render only available options instead of a
// hardcoded list. Reads Meilisearch facetDistribution for study_type + source.
@Controller("api/facets")
class FacetsController {
  constructor(private readonly cache: CacheService) {}

  @Get()
  async facets() {
    return this.cache.getOrSet("facets:v1", FACETS_TTL_SEC, async () => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (MEILI_KEY) headers.authorization = `Bearer ${MEILI_KEY}`;

      const r = await fetch(`${MEILI_URL}/indexes/documents/search`, {
        method: "POST",
        headers,
        body: JSON.stringify({ q: "", limit: 0, facets: ["study_type", "source", "mesh_terms"] }),
      });
      if (!r.ok) throw new HttpException(`meili ${r.status}`, HttpStatus.BAD_GATEWAY);
      const data = (await r.json()) as any;
      const dist = data.facetDistribution ?? {};

      // {value: count} -> [{value, count}] sorted by count desc, optionally capped.
      const toList = (m: Record<string, number> | undefined, cap?: number) => {
        const list = Object.entries(m ?? {})
          .map(([value, count]) => ({ value, count }))
          .sort((a, b) => b.count - a.count);
        return cap ? list.slice(0, cap) : list;
      };

      return {
        studyTypes: toList(dist.study_type),
        sources: toList(dist.source),
        // MeSH is high-cardinality; expose only the most common terms as facets.
        meshTerms: toList(dist.mesh_terms, 20),
      };
    });
  }
}

@Module({ controllers: [FacetsController] })
export class FacetsModule {}
