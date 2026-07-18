import { Controller, Get, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { SearchService } from "./search.service.js";

@Controller("api/search")
export class SearchController {
  constructor(private readonly svc: SearchService) {}

  @Get()
  @Throttle({ rest: { ttl: 60_000, limit: 60 } })
  async search(
    @Query("q") q: string,
    @Query("filters") filters?: string,
    @Query("top_k") topK?: string,
    @Query("variant") variant?: string,
    @Query("session_id") sessionId?: string,
  ) {
    let parsed = undefined;
    if (filters) {
      try { parsed = JSON.parse(filters); } catch { /* ignore */ }
    }
    return this.svc.search(q, parsed, topK ? parseInt(topK, 10) : 50, variant, sessionId);
  }
}
