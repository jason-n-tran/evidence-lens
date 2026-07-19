import { Global, Injectable, Logger, Module, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";

/**
 * Shared Valkey/Redis cache for the gateway. Used to cache expensive,
 * slowly-changing responses (facet distributions, recall lists, document
 * lookups) so repeated requests don't re-hit Meilisearch/Postgres/Neo4j.
 *
 * Fail-open by design: if Valkey is unreachable, every method degrades to a
 * cache miss (getOrSet just runs the loader). The gateway never errors because
 * the cache is down — it just gets slower. Connection is lazy and a failed
 * connect disables the client rather than throwing.
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private redis: Redis | null = null;

  constructor() {
    // Opt-out: set CACHE_DISABLED=1 to bypass entirely (everything fails open).
    if (process.env.CACHE_DISABLED === "1") {
      this.logger.log("CACHE_DISABLED=1 — gateway response cache off.");
      return;
    }
    const client = new Redis({
      host: process.env.REDIS_HOST ?? "redis",
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      db: Number(process.env.REDIS_DB ?? 0),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      // Don't spam reconnects forever if Valkey is absent; back off then stop.
      retryStrategy: (times) => (times > 5 ? null : Math.min(times * 200, 1000)),
    });
    client.on("error", (e) => {
      // Log once-ish; ioredis emits on every retry. Keep it quiet at warn.
      this.logger.warn(`valkey error (cache fails open): ${e.message}`);
    });
    client.connect().catch((e) => {
      this.logger.warn(`valkey connect failed (cache disabled): ${e.message}`);
      this.redis = null;
    });
    this.redis = client;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
    } catch {
      /* non-fatal: cache write failure must never break the request */
    }
  }

  /**
   * Cache-aside helper: return the cached value, else run `loader`, cache its
   * result for `ttlSeconds`, and return it. On any cache error, just returns
   * `loader()` (fail-open).
   */
  async getOrSet<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== null && hit !== undefined) return hit;
    const value = await loader();
    // Only cache non-empty-ish values; don't pin a transient failure/empty.
    if (value !== null && value !== undefined) {
      await this.set(key, value, ttlSeconds);
    }
    return value;
  }

  /** Best-effort invalidation by exact key. */
  async del(key: string): Promise<void> {
    if (!this.redis) return;
    try { await this.redis.del(key); } catch { /* non-fatal */ }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) {
      try { await this.redis.quit(); } catch { /* noop */ }
    }
  }
}

@Global()
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
