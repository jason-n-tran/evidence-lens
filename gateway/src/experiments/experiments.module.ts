import { Controller, Get, Headers, Module, Query, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";

/**
 * A/B variant assignment per spec §11.3.
 *
 * Bucketing: SHA-256(session_id + experiment_key) % 10000 → cumulative
 * weight buckets. Deterministic, no server-side state required for the
 * decision itself. Audited to Postgres via the audit row written
 * alongside the assignment cookie response.
 *
 * Experiment definitions are loaded at startup from
 * config/experiments.yaml (passed through env EXPERIMENTS_JSON for the
 * Worker / serverless paths that can't read the file).
 */
interface Variant { name: string; weight: number; params?: Record<string, unknown> }
interface ExperimentDef { enabled: boolean; variants: Variant[] }

const EXPERIMENTS: Record<string, ExperimentDef> = (() => {
  try {
    return JSON.parse(process.env.EXPERIMENTS_JSON ?? "{}");
  } catch {
    return {};
  }
})();

@Injectable()
export class ExperimentService {
  assign(sessionId: string, key: string): { variant: string; params?: Record<string, unknown> } {
    const def = EXPERIMENTS[key];
    if (!def?.enabled || !def.variants?.length) {
      return { variant: "control" };
    }
    const total = def.variants.reduce((s, v) => s + (v.weight || 0), 0) || 1;
    const h = createHash("sha256").update(`${sessionId}::${key}`).digest();
    // Take first 4 bytes as uint32 → modulo 10000.
    const n = h.readUInt32BE(0) % 10000;
    let cum = 0;
    for (const v of def.variants) {
      cum += Math.floor((v.weight / total) * 10000);
      if (n < cum) return { variant: v.name, params: v.params };
    }
    return { variant: def.variants[def.variants.length - 1].name, params: def.variants[def.variants.length - 1].params };
  }
}

@Controller("api/experiments")
class ExperimentsController {
  constructor(private readonly svc: ExperimentService) {}

  /** Frontend calls this once per page load to know its A/B variants. */
  @Get("assignment")
  assign(@Query("session_id") sessionId: string, @Query("keys") keys?: string) {
    if (!sessionId) return {};
    const out: Record<string, { variant: string; params?: Record<string, unknown> }> = {};
    const requested = (keys?.split(",").map(s => s.trim()) ?? Object.keys(EXPERIMENTS)).filter(Boolean);
    for (const k of requested) out[k] = this.svc.assign(sessionId, k);
    return out;
  }
}

@Module({
  providers: [ExperimentService],
  controllers: [ExperimentsController],
  exports: [ExperimentService],
})
export class ExperimentsModule {}
