import Link from "next/link";

const SECTIONS = [
  {
    href: "/docs/api",
    eyebrow: "REST · GraphQL · WebSocket",
    title: "Query API",
    body: "Three read-only transports over one data plane. No auth. Streamed result waves over WebSocket.",
  },
  {
    href: "/docs/mcp",
    eyebrow: "Model Context Protocol",
    title: "MCP server",
    body: "Connect Claude, ChatGPT, or any MCP client to eight evidence tools. Public, no key.",
  },
  {
    href: "/docs/byok",
    eyebrow: "Bring Your Own Key",
    title: "BYOK setup",
    body: "Supply your own Anthropic / OpenAI-compatible / Ollama key for synthesis. Keys never leave your browser.",
  },
] as const;

export default function DocsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <p className="eyebrow mb-2">Documentation</p>
      <h1 className="font-sans text-3xl font-semibold tracking-tight">How to use EvidenceLens</h1>
      <p className="evidence mt-3 text-[hsl(var(--muted))]">
        EvidenceLens is a search engine first. These pages cover the programmatic ways in —
        the public API, the MCP tool server, and bring-your-own-key synthesis.
      </p>

      <div className="tick-rule my-8" />

      <div className="grid gap-3 sm:grid-cols-3">
        {SECTIONS.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="specimen block p-4 no-underline"
          >
            <p className="eyebrow">{s.eyebrow}</p>
            <h2 className="font-sans text-lg font-medium mt-1 text-[hsl(var(--ink))]">{s.title}</h2>
            <p className="evidence text-sm mt-1.5 text-[hsl(var(--muted))]">{s.body}</p>
          </Link>
        ))}
      </div>

      <div className="tick-rule my-8" />

      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm font-sans">
        <a href="https://github.com/evidencelens/evidencelens">Source on GitHub ↗</a>
        <Link href="/licenses">Data licenses</Link>
        <Link href="/changelog">Changelog</Link>
      </div>
    </div>
  );
}
