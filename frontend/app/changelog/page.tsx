type Entry = { date: string; tag: string; items: string[] };

// Highlights only — GitHub Releases is the canonical, complete history.
const ENTRIES: Entry[] = [
  {
    date: "2026-06",
    tag: "Deploy",
    items: [
      "Simplified deployment to a single Docker Compose stack with per-tier overlays (local, VPS, TrueNAS, working-PC).",
      "Removed Cloudflare Workers / Tunnel / KV and all GCP services — gateway middleware and an ofelia cron sidecar replace them.",
      "Public API + MCP now served from evidencelens.mykpoplists.com behind Dokploy/Traefik with automatic TLS.",
    ],
  },
  {
    date: "2026-06-10",
    tag: "Fixes",
    items: [
      "Embedder no longer crashes on startup (called a non-existent dimension method).",
      "Recency decay now correctly returns 0.5 at one half-life.",
      "Open Payments author matching fixed for initials-only names, reducing false COI joins.",
      "Processor chunker falls back to whitespace tokenization when tiktoken can't fetch its vocab offline.",
    ],
  },
  {
    date: "2026-05",
    tag: "Pipeline",
    items: [
      "29 ingesters implemented; pubmed, trials, fda, and preprint wired into the cron schedule.",
      "Three-wave WebSocket result streaming (5 + 10 + 35) so first hits render while the long tail finishes.",
      "BGE-M3 (GPU, 1024-d) embedder with BGE-small (CPU, 384-d) fallback and dynamic batching.",
    ],
  },
];

export default function ChangelogPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <p className="eyebrow mb-2">Release notes</p>
      <h1 className="font-sans text-3xl font-semibold tracking-tight">Changelog</h1>
      <p className="evidence mt-3 text-[hsl(var(--muted))]">
        Selected highlights below.{" "}
        <a href="https://github.com/evidencelens/evidencelens/releases">GitHub Releases</a>{" "}
        is the canonical, complete history.
      </p>

      <div className="tick-rule my-8" />

      <div className="space-y-8">
        {ENTRIES.map((e) => (
          <section key={e.date} className="grid grid-cols-1 sm:grid-cols-[7rem_1fr] gap-2 sm:gap-6">
            <div className="flex sm:flex-col items-start gap-2">
              <time className="data text-sm font-medium text-[hsl(var(--ink))] whitespace-nowrap">{e.date}</time>
              <span className="tag">{e.tag}</span>
            </div>
            <ul className="space-y-2">
              {e.items.map((it, i) => (
                <li key={i} className="evidence text-sm text-[hsl(var(--muted))] relative pl-4">
                  <span aria-hidden="true" className="absolute left-0 top-2 h-1 w-1 rounded-full bg-[hsl(var(--accent-bright))]" />
                  {it}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
