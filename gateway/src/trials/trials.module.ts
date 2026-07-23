import { Controller, Get, HttpException, HttpStatus, Module, Query } from "@nestjs/common";

const MEILI_URL = process.env.MEILI_URL ?? "http://meilisearch:7700";
const MEILI_KEY = process.env.MEILI_KEY ?? "";

@Controller("api/trials")
class TrialsController {
  @Get()
  async list(
    @Query("condition") condition?: string,
    @Query("location") location?: string,
    @Query("status") status?: string,
    @Query("phase") phase?: string,
    @Query("top_k") topK = "50",
  ) {
    const filter: string[] = [`source IN ["ctgov","ictrp"]`];
    if (status) filter.push(`trial_status = ${JSON.stringify(status.toLowerCase())}`);
    if (phase)  filter.push(`trial_phase = ${JSON.stringify(phase.toLowerCase())}`);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (MEILI_KEY) headers.authorization = `Bearer ${MEILI_KEY}`;
    const r = await fetch(`${MEILI_URL}/indexes/documents/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        q: condition ?? "",
        filter,
        limit: Math.min(parseInt(topK, 10) || 50, 200),
        attributesToRetrieve: ["id", "title", "abstract", "trial", "publishedAt", "source"],
      }),
    });
    if (!r.ok) throw new HttpException(`meili ${r.status}`, HttpStatus.BAD_GATEWAY);
    const data = await r.json() as any;
    const hits = data.hits ?? [];
    const filtered = location
      ? hits.filter((h: any) =>
          (h.trial?.locations ?? []).some((l: string) => l.toLowerCase().includes(location.toLowerCase())))
      : hits;
    return { condition, location, status, phase, results: filtered };
  }
}

@Module({ controllers: [TrialsController] })
export class TrialsModule {}
