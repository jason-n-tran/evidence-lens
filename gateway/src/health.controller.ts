import { Controller, Get, HttpException, HttpStatus } from "@nestjs/common";

const SCORER_URL    = process.env.SCORER_HTTP_URL ?? "http://scorer:8090";
const MEILI_URL     = process.env.MEILI_URL       ?? "http://meilisearch:7700";
const MILVUS_URI    = process.env.MILVUS_URI      ?? "http://milvus:19530";
// Milvus health endpoint is on the metrics port (9091), not the service port (19530)
const MILVUS_HEALTH = process.env.MILVUS_HEALTH_URL
  ?? MILVUS_URI.replace(/:19530$/, ":9091") + "/healthz";
const NATS_MON_URL  = (process.env.NATS_URL ?? "http://nats:8222")
  .replace(/^nats:/, "http:")
  .replace(/:4222$/, ":8222");

interface ProbeResult { ok: boolean; latencyMs: number; detail?: string }

async function probe(url: string, timeoutMs = 1500): Promise<ProbeResult> {
  const start = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return { ok: r.ok, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, detail: (e as Error).message };
  } finally {
    clearTimeout(t);
  }
}

@Controller()
export class HealthController {
  @Get("healthz")
  healthz() {
    return { status: "ok" };
  }

  @Get("readyz")
  async readyz() {
    const checks = await Promise.all([
      probe(`${SCORER_URL}/healthz`).then(r => ["scorer", r] as const),
      probe(`${MEILI_URL}/health`).then(r => ["meilisearch", r] as const),
      probe(MILVUS_HEALTH).then(r => ["milvus", r] as const),
      probe(`${NATS_MON_URL}/healthz`).then(r => ["nats", r] as const),
    ]);
    const summary: Record<string, ProbeResult> = {};
    let allOk = true;
    for (const [name, r] of checks) {
      summary[name] = r;
      if (!r.ok) allOk = false;
    }
    if (!allOk) {
      throw new HttpException({ status: "degraded", checks: summary }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { status: "ready", checks: summary };
  }
}
