"use client";

// Session identity + A/B assignment + click logging.
//
// Why this exists: the gateway has a fully-built clicks table + /api/_internal/
// clicks endpoint and an /api/experiments/assignment endpoint, but the frontend
// never called either. Without click logging, A/B testing (and LTR training,
// which learns from clicks) has no data. This module wires both up.

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8080";
const SESSION_KEY = "evidencelens.session_id";
const EXPERIMENT_KEY = "search_ranking"; // the ranking A/B experiment key

// Stable per-browser session id (persisted). Used for deterministic A/B
// bucketing and to group a user's clicks.
export function getSessionId(): string {
  if (typeof window === "undefined") return "ssr";
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = (crypto.randomUUID?.() ?? `s-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

let _variant: string | null = null;

// Fetch (once) this session's variant for the ranking experiment. Cached in
// memory after the first call. Returns "control" on any failure.
export async function getVariant(): Promise<string> {
  if (_variant) return _variant;
  try {
    const sid = getSessionId();
    const r = await fetch(
      `${GATEWAY_URL}/api/experiments/assignment?session_id=${encodeURIComponent(sid)}&keys=${EXPERIMENT_KEY}`,
    );
    if (r.ok) {
      const d = await r.json();
      _variant = d?.[EXPERIMENT_KEY]?.variant ?? "control";
    } else {
      _variant = "control";
    }
  } catch {
    _variant = "control";
  }
  return _variant!;
}

export interface ClickContext {
  queryId: string;
  queryText: string;
  variant?: string | null;
  docId: string;
  position: number;
  resultSetSize?: number;
}

// Fire-and-forget click logging. Never blocks navigation or throws.
export function logClick(ctx: ClickContext): void {
  if (typeof window === "undefined") return;
  const event = {
    event_id: crypto.randomUUID?.() ?? `e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    session_id: getSessionId(),
    query_id: ctx.queryId,
    query_text: ctx.queryText,
    variant: ctx.variant ?? _variant ?? null,
    clicked_doc_id: ctx.docId,
    clicked_position: ctx.position,
    result_set_size: ctx.resultSetSize ?? null,
    client_ts: new Date().toISOString(),
  };
  // keepalive lets the POST survive the page navigation that a click triggers.
  try {
    fetch(`${GATEWAY_URL}/api/_internal/clicks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [event] }),
      keepalive: true,
    }).catch(() => { /* analytics is best-effort */ });
  } catch {
    /* ignore */
  }
}
