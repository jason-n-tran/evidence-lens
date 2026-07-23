import { Controller, Get, Injectable, Module, OnModuleDestroy, OnModuleInit, Query } from "@nestjs/common";
import { Pool } from "pg";
import { connect as natsConnect, NatsConnection, Subscription } from "nats";
import { CacheService } from "../cache/cache.module.js";

const NATS_URL = process.env.NATS_URL ?? "nats://nats:4222";

// FDA sends classification like "Class I"/"Class II"/"Class III"; the
// recall_events.recall_class CHECK constraint only allows I/II/III (or NULL).
function normalizeRecallClass(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = raw.toUpperCase().match(/\b(III|II|I)\b/);
  return m ? m[1] : null;
}

// Always-on subscriber that persists every recall-fanout event into the
// recall_events table so the recalls page (which reads that table) has data.
// This is separate from the ws-module's per-client streaming subscription —
// that one only runs while a browser is watching and never persists.
@Injectable()
class RecallWriter implements OnModuleInit, OnModuleDestroy {
  private nc: NatsConnection | null = null;
  private sub: Subscription | null = null;
  private pool: Pool | null = null;

  async onModuleInit(): Promise<void> {
    if (!process.env.DATABASE_URL) return;
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      this.nc = await natsConnect({ servers: NATS_URL });
    } catch (err) {
      console.error("[recall-writer] nats connect failed; recalls won't persist:", err);
      return;
    }
    this.sub = this.nc.subscribe("recall-fanout");
    (async () => {
      for await (const msg of this.sub!) {
        try {
          const e = JSON.parse(new TextDecoder().decode(msg.data));
          await this.pool!.query(
            `INSERT INTO recall_events
               (id, agency, product_name, drug_class, recall_class, emitted_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (id) DO NOTHING`,
            [
              e.recall_id,
              e.agency ?? "fda",
              e.product_name ?? "",
              e.drug_class || null,
              normalizeRecallClass(e.recall_class),
              e.emitted_at ?? new Date().toISOString(),
            ],
          );
        } catch (err) {
          console.error("[recall-writer] persist failed:", err);
        }
      }
    })();
  }

  async onModuleDestroy(): Promise<void> {
    try { this.sub?.unsubscribe(); } catch { /* noop */ }
    if (this.nc) await this.nc.drain();
    if (this.pool) await this.pool.end();
  }
}

@Controller("api/recalls")
class RecallsController implements OnModuleInit, OnModuleDestroy {
  private pool: Pool | null = null;
  constructor(private readonly cache: CacheService) {}

  async onModuleInit(): Promise<void> {
    if (!process.env.DATABASE_URL) return;
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) await this.pool.end();
  }

  @Get("recent")
  async recent(
    @Query("since_days") sinceDays = "30",
    @Query("drug_class") drugClass?: string,
    @Query("product_name") productName?: string,
    @Query("top_k") topK = "20",
  ) {
    if (!this.pool) {
      return { sinceDays: parseInt(sinceDays, 10), events: [], note: "DATABASE_URL not configured" };
    }
    const days = parseInt(sinceDays, 10) || 30;
    const limit = Math.min(parseInt(topK, 10) || 20, 200);
    // Recalls arrive at most a few times/day (FDA ingest cadence); the page is
    // hit on every visit. Cache per distinct query for a short window.
    const ttl = Number(process.env.RECALLS_CACHE_TTL_SEC ?? 60);
    const key = `recalls:v1:${days}:${limit}:${drugClass ?? ""}:${productName ?? ""}`;
    return this.cache.getOrSet(key, ttl, async () => {
      const where: string[] = [`emitted_at >= NOW() - ($1::int * INTERVAL '1 day')`];
      const params: any[] = [days];
      if (drugClass)  { params.push(drugClass);   where.push(`drug_class = $${params.length}`); }
      if (productName){ params.push(productName); where.push(`product_name = $${params.length}`); }
      params.push(limit);
      const sql =
        `SELECT id AS recall_id, agency, product_name, drug_class, recall_class, emitted_at
         FROM recall_events
         WHERE ${where.join(" AND ")}
         ORDER BY emitted_at DESC
         LIMIT $${params.length}`;
      const r = await this.pool!.query(sql, params);
      // Map snake_case columns to the camelCase shape the frontend reads
      // (recalls page binds e.productName / e.recallClass / e.emittedAt etc).
      const events = r.rows.map((row: any) => ({
        recallId: row.recall_id,
        agency: row.agency,
        productName: row.product_name,
        drugClass: row.drug_class,
        recallClass: row.recall_class,
        emittedAt: row.emitted_at,
      }));
      return { sinceDays: days, drugClass, productName, events };
    });
  }
}

@Module({ controllers: [RecallsController], providers: [RecallWriter] })
export class RecallsModule {}
