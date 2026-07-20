import {
  Body, Controller, ForbiddenException, Headers, HttpCode,
  Injectable, Module, OnModuleDestroy, Post,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Pool } from "pg";

/**
 * Click event ingestion endpoint. When INTERNAL_TOKEN is set, the
 * endpoint requires the matching x-internal-token header (legacy
 * Cloudflare Worker mode); when unset, the endpoint accepts unauthenticated
 * posts and relies on the gateway-wide rate limiter.
 */
interface ClickRow {
  event_id: string;
  session_id: string;
  query_id: string;
  query_text: string;
  variant?: string | null;
  clicked_doc_id: string;
  clicked_position: number;
  result_set_size?: number | null;
  facets?: unknown;
  client_ts?: string | null;
  user_agent?: string | null;
  country?: string | null;
}

@Injectable()
export class ClicksService implements OnModuleDestroy {
  private pool: Pool;
  private readonly internalToken = process.env.INTERNAL_TOKEN ?? "";

  constructor() {
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }

  authorize(token: string | undefined): void {
    if (!this.internalToken) return; // open-mode (no Worker in front)
    if (token !== this.internalToken) {
      throw new ForbiddenException("invalid internal token");
    }
  }

  async insertBatch(rows: ClickRow[]): Promise<number> {
    if (!rows.length) return 0;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const text = `
        INSERT INTO clicks (
          event_id, session_id, query_id, query_text, variant,
          clicked_doc_id, clicked_position, result_set_size, facets,
          client_ts, user_agent, country
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (event_id) DO NOTHING
      `;
      for (const r of rows) {
        await client.query(text, [
          r.event_id, r.session_id, r.query_id, r.query_text, r.variant ?? null,
          r.clicked_doc_id, r.clicked_position, r.result_set_size ?? null,
          r.facets ? JSON.stringify(r.facets) : null,
          r.client_ts ?? null, r.user_agent ?? null, r.country ?? null,
        ]);
      }
      await client.query("COMMIT");
      return rows.length;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

@Controller("api/_internal/clicks")
class ClicksController {
  constructor(private readonly svc: ClicksService) {}

  @Post()
  @HttpCode(202)
  @Throttle({ rest: { ttl: 60_000, limit: 60 } })
  async ingest(
    @Headers("x-internal-token") token: string | undefined,
    @Body() body: { events: ClickRow[] },
  ) {
    this.svc.authorize(token);
    const inserted = await this.svc.insertBatch(body.events ?? []);
    return { inserted };
  }
}

@Module({
  providers: [ClicksService],
  controllers: [ClicksController],
})
export class ClicksModule {}
