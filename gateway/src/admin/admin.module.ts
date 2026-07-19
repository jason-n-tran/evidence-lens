import { Controller, Get, Module } from "@nestjs/common";

const SCORER_URL    = process.env.SCORER_HTTP_URL ?? "http://scorer:8090";
const MEILI_URL     = process.env.MEILI_URL       ?? "http://meilisearch:7700";
const MILVUS_URI    = process.env.MILVUS_URI      ?? "http://milvus:19530";
const MILVUS_HEALTH = process.env.MILVUS_HEALTH_URL
  ?? MILVUS_URI.replace(/:19530$/, ":9091") + "/healthz";
const NATS_MON   = (process.env.NATS_URL ?? "http://nats:8222")
  .replace(/^nats:/, "http:")
  .replace(/:4222$/, ":8222");

async function probe(url: string): Promise<{ ok: boolean; ms: number }> {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return { ok: r.ok, ms: Date.now() - t0 };
  } catch {
    return { ok: false, ms: Date.now() - t0 };
  }
}

@Controller("admin")
class AdminController {
  // Internal-only. Behind Cloudflare Access in production.
  @Get("status")
  async status() {
    const [scorer, meili, milvus, nats] = await Promise.all([
      probe(`${SCORER_URL}/healthz`),
      probe(`${MEILI_URL}/health`),
      probe(MILVUS_HEALTH),
      probe(`${NATS_MON}/healthz`),
    ]);
    return {
      uptime_seconds: process.uptime(),
      pid: process.pid,
      memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      probes: { scorer, meili, milvus, nats },
      ts: new Date().toISOString(),
    };
  }
}

@Module({ controllers: [AdminController] })
export class AdminModule {}
