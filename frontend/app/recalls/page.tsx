"use client";

import { useEffect, useState } from "react";

// Client-rendered (static export): fetches the gateway in the browser. The
// gateway is public, so this works the same as the old server fetch — just from
// the client. NEXT_PUBLIC_GATEWAY_URL is inlined at build time.
const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8080";

export default function RecallsPage() {
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch(`${GATEWAY_URL}/api/recalls/recent?since_days=30`)
      .then(r => r.ok ? r.json() : { events: [] })
      .then(d => { if (!cancelled) setEvents(d.events ?? []); })
      .catch(() => { if (!cancelled) setEvents([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="mx-auto max-w-4xl px-4 py-12">
      <p className="eyebrow mb-2 flex items-center gap-1.5">
        <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[hsl(var(--coi-bright))]" />
        Safety signal · last 30 days
      </p>
      <h1 className="font-sans text-3xl font-semibold tracking-tight">Recent recalls</h1>
      <p className="evidence mt-3 text-[hsl(var(--muted))]">
        Drug and device recall events from FDA and EMA, newest first. Sourced from public
        regulatory feeds — verify the class and scope against the original notice before acting.
      </p>

      <div className="tick-rule my-8" />

      {loading && <p className="eyebrow animate-pulse">Loading recall feed…</p>}
      {!loading && events.length === 0 && (
        <p className="evidence text-[hsl(var(--muted))]">No recalls in the last 30 days.</p>
      )}

      <ul className="space-y-3">
        {events.map((e: any, i: number) => (
          <li key={e.recallId ?? i} className="specimen p-4">
            <div className="flex flex-wrap items-center gap-2 mb-1.5">
              <span className="tag tag-strong">{(e.agency ?? "—").toUpperCase()} · Class {e.recallClass ?? "—"}</span>
              {e.drugClass && <span className="tag">{e.drugClass}</span>}
              {e.emittedAt && (
                <time className="eyebrow data ml-auto">{new Date(e.emittedAt).toLocaleDateString()}</time>
              )}
            </div>
            <div className="font-sans font-medium">{e.productName || "—"}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
