/**
 * MCP per-session tool-call rate limit (spec §13.3): 30 calls/min per
 * MCP session. Sliding-window counter; in-memory because the MCP
 * server is single-process per Dokploy instance and sessions are short
 * enough that we don't need Redis.
 */
const WINDOW_MS = 60_000;
const LIMIT     = parseInt(process.env.MCP_RATE_LIMIT_PER_MIN ?? "30", 10);

interface SessionState { hits: number[] }
const sessions = new Map<string, SessionState>();

export function check(sessionId: string): { ok: boolean; retryAfterSec: number; remaining: number } {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  let s = sessions.get(sessionId);
  if (!s) { s = { hits: [] }; sessions.set(sessionId, s); }
  s.hits = s.hits.filter(t => t > cutoff);
  if (s.hits.length >= LIMIT) {
    const retry = Math.ceil((s.hits[0] + WINDOW_MS - now) / 1000);
    return { ok: false, retryAfterSec: Math.max(1, retry), remaining: 0 };
  }
  s.hits.push(now);
  // Periodically GC empty sessions.
  if (sessions.size > 1024) {
    for (const [k, v] of sessions) {
      if (v.hits.length === 0) sessions.delete(k);
    }
  }
  return { ok: true, retryAfterSec: 0, remaining: LIMIT - s.hits.length };
}

export function reset(sessionId: string): void {
  sessions.delete(sessionId);
}
