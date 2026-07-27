"use client";

import { useEffect, useState } from "react";

interface Recall { recallId: string; productName: string; agency: string; recallClass: string; emittedAt: string }

export function RecallTicker() {
  const [items, setItems] = useState<Recall[]>([]);
  useEffect(() => {
    fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/recalls/recent?since_days=7&top_k=5`)
      .then(r => r.ok ? r.json() : { events: [] })
      .then(data => setItems(data.events ?? []))
      .catch(() => {});
  }, []);

  if (items.length === 0) return null;
  return (
    <section aria-labelledby="recalls-h" className="panel p-4 text-sm">
      <h2 id="recalls-h" className="eyebrow mb-2.5 flex items-center gap-1.5">
        <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[hsl(var(--coi-bright))]" />
        Recent recalls · last 7 days
      </h2>
      <ul className="divide-y divide-[hsl(var(--rule))]">
        {items.map(r => (
          <li key={r.recallId} className="flex items-center gap-2 py-1.5">
            <span className="tag">{r.agency.toUpperCase()} · C{r.recallClass}</span>
            <span className="truncate">{r.productName}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
