import { Injectable, Module, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import Redis from "ioredis";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const CACHE_TTL_SEC = 300;

@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);
  private readonly secret = process.env.TURNSTILE_SECRET ?? "";
  private redis: Redis | null = null;

  constructor() {
    if (!this.secret) {
      this.logger.log("TURNSTILE_SECRET unset — Turnstile validation disabled.");
      return;
    }
    this.redis = new Redis({
      host: process.env.REDIS_HOST ?? "redis",
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      db: Number(process.env.REDIS_DB ?? 0),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    this.redis.connect().catch((e) =>
      this.logger.warn(`redis connect failed (${e.message}); falling back to per-request verify`),
    );
  }

  get enabled(): boolean {
    return Boolean(this.secret);
  }

  async verify(token: string | undefined, remoteIp?: string): Promise<boolean> {
    if (!this.enabled) return true;
    if (!token) return false;

    const cacheKey = `ts:${createHash("sha256").update(token).digest("hex")}`;
    if (this.redis) {
      try {
        const cached = await this.redis.get(cacheKey);
        if (cached === "1") return true;
        if (cached === "0") return false;
      } catch {
        /* fall through to upstream call */
      }
    }

    const form = new URLSearchParams({ secret: this.secret, response: token });
    if (remoteIp) form.set("remoteip", remoteIp);
    let ok = false;
    try {
      const res = await fetch(VERIFY_URL, { method: "POST", body: form });
      const data = (await res.json()) as { success?: boolean };
      ok = Boolean(data.success);
    } catch (e) {
      this.logger.warn(`siteverify failed: ${(e as Error).message}`);
      return false;
    }

    if (this.redis) {
      try {
        await this.redis.set(cacheKey, ok ? "1" : "0", "EX", CACHE_TTL_SEC);
      } catch {
        /* non-fatal */
      }
    }
    return ok;
  }
}

@Module({
  providers: [TurnstileService],
  exports: [TurnstileService],
})
export class TurnstileModule {}
