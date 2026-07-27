"use client";

import { useState } from "react";

// The public MCP endpoint is the gateway origin + /mcp (the gateway relays it to
// the internal mcp-server). Derive it from the same env the rest of the app uses
// so it stays correct across environments instead of being hardcoded.
const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8080";
const MCP_URL = `${GATEWAY_URL.replace(/\/$/, "")}/mcp`;

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <span className="text-xs text-[hsl(var(--muted))]">{label}</span>
      <div className="flex items-stretch gap-1">
        <code className="flex-1 text-xs bg-[hsl(var(--muted)/0.12)] rounded px-2 py-1 break-all">
          {value}
        </code>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(value).then(
              () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
              () => { /* clipboard blocked; user can select manually */ },
            );
          }}
          className="shrink-0 rounded border border-[hsl(var(--accent))] text-[hsl(var(--accent))] px-2 text-xs"
          aria-label={`Copy ${label}`}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/**
 * MCP tier panel. The MCP server is already live and public — there's nothing
 * to install on our side. This component gives visitors a copy-paste endpoint
 * and step-by-step instructions to connect a client and demonstrate the tools,
 * including a zero-cost path (MCP Inspector) that needs no account.
 */
export function McpSetup() {
  return (
    <div className="space-y-4 text-sm">
      <p className="text-[hsl(var(--muted))] text-xs">
        EvidenceLens exposes a public MCP server (Streamable HTTP). Point any MCP
        client at the endpoint below — all 8 evidence tools work immediately, no
        API key required.
      </p>

      <CopyField label="MCP endpoint (Streamable HTTP)" value={MCP_URL} />

      {/* Free, no-account path first — anyone can run this in ~1 minute. */}
      <details open className="rounded border border-[hsl(var(--border))] p-3">
        <summary className="cursor-pointer font-medium">
          Test it free with the MCP Inspector (no account)
        </summary>
        <ol className="mt-2 list-decimal space-y-2 pl-5 text-xs text-[hsl(var(--muted))]">
          <li>
            You need <a className="text-[hsl(var(--accent))] underline" href="https://nodejs.org" target="_blank" rel="noopener noreferrer">Node.js</a>.
            In a terminal, run:
            <code className="mt-1 block bg-[hsl(var(--muted)/0.12)] rounded px-2 py-1">npx @modelcontextprotocol/inspector</code>
            It opens a browser tab automatically (use the printed
            <code className="px-1">http://localhost:6274/?MCP_PROXY_AUTH_TOKEN=…</code> link;
            the token must match).
          </li>
          <li>
            In the Inspector, set <strong>Transport Type</strong> to{" "}
            <strong>Streamable HTTP</strong> and paste the endpoint above as the{" "}
            <strong>URL</strong>. Leave headers empty.
          </li>
          <li>Click <strong>Connect</strong> — the status turns green once the handshake succeeds.</li>
          <li>
            Open the <strong>Tools</strong> tab → <strong>List Tools</strong> (you’ll see all 8),
            pick <code className="px-1">search_evidence</code>, enter arguments
            <code className="mt-1 block bg-[hsl(var(--muted)/0.12)] rounded px-2 py-1">{`{ "query": "aspirin cardiovascular", "top_k": 5 }`}</code>
            and click <strong>Run Tool</strong>. Ranked results come back with COI badges.
          </li>
        </ol>
        <p className="mt-2 text-[11px] text-[hsl(var(--muted))]">
          If Connect fails, the Inspector’s local proxy is occasionally flaky — relaunch with
          <code className="px-1">DANGEROUSLY_OMIT_AUTH=true npx @modelcontextprotocol/inspector</code>
          then open <code className="px-1">http://localhost:6274</code>.
        </p>
      </details>

      {/* The real-world use case: add it as a connector in a chat client. */}
      <details className="rounded border border-[hsl(var(--border))] p-3">
        <summary className="cursor-pointer font-medium">
          Add as a connector in Claude.ai or ChatGPT
        </summary>
        <ul className="mt-2 list-disc space-y-2 pl-5 text-xs text-[hsl(var(--muted))]">
          <li>
            <strong>Claude.ai</strong> (free tier allows one custom connector):
            Settings → Connectors → <strong>Add custom connector</strong> → paste the endpoint
            above. Then ask Claude e.g. “Use EvidenceLens to find recent RCTs on SGLT2 inhibitors.”
          </li>
          <li>
            <strong>ChatGPT</strong> (Developer mode / connectors): add a connector with the same
            URL. ChatGPT requires Streamable HTTP, which this endpoint already uses.
          </li>
          <li>
            <strong>Claude Desktop / Cursor / Cline</strong>: add a remote MCP server pointing at
            the endpoint above (these clients call it directly — no repo or local server needed).
          </li>
        </ul>
      </details>

      {/* Power users / verification without any client. */}
      <details className="rounded border border-[hsl(var(--border))] p-3">
        <summary className="cursor-pointer font-medium">Verify with curl</summary>
        <pre className="mt-2 whitespace-pre-wrap break-all text-[11px] bg-[hsl(var(--muted)/0.12)] rounded p-2">{`curl -X POST ${MCP_URL} \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2025-06-18","capabilities":{},
       "clientInfo":{"name":"curl","version":"0"}}}'`}</pre>
        <p className="mt-1 text-[11px] text-[hsl(var(--muted))]">
          A JSON-RPC result naming <code className="px-1">evidencelens</code> confirms the server is reachable.
        </p>
      </details>
    </div>
  );
}
