export default function DocsMcpPage() {
  const endpoint = "https://evidencelens.mykpoplists.com/mcp";
  return (
    <article className="mx-auto max-w-3xl px-4 py-12 prose">
      <div className="eyebrow mb-2">Model Context Protocol</div>
      <h1>MCP server</h1>
      <p>
        EvidenceLens implements the Anthropic{" "}
        <a href="https://modelcontextprotocol.io/">Model Context Protocol</a> so any MCP-aware
        client — Claude, ChatGPT, IDE plugins, custom agents — can call its evidence tools
        directly. The server is public and needs no API key.
      </p>

      <h2>Endpoint</h2>
      <ul>
        <li>
          <strong>Remote (Streamable HTTP):</strong> <code>{endpoint}</code>
          <br />
          This is the modern MCP transport (a single endpoint), which both Claude.ai custom
          connectors and ChatGPT require. A legacy HTTP+SSE endpoint also exists at{" "}
          <code>/sse</code> for older clients, but new integrations should use{" "}
          <code>/mcp</code>.
        </li>
        <li>
          <strong>Local (stdio):</strong> build from{" "}
          <a href="https://github.com/evidencelens/evidencelens/tree/main/mcp-server">mcp-server/</a>{" "}
          and run <code>node dist/server.js</code> (set{" "}
          <code>GATEWAY_URL=https://evidencelens.mykpoplists.com</code>).
        </li>
      </ul>

      <h2>Test it free with the MCP Inspector</h2>
      <p>No account needed. With <a href="https://nodejs.org">Node.js</a> installed:</p>
      <ol>
        <li>
          Run <code>npx @modelcontextprotocol/inspector</code> (it opens a browser tab; use the
          printed <code>localhost:6274</code> link with its token).
        </li>
        <li>
          Set <strong>Transport Type</strong> to <strong>Streamable HTTP</strong> and paste the
          endpoint above as the <strong>URL</strong>, then <strong>Connect</strong>.
        </li>
        <li>
          <strong>Tools → List Tools</strong>, pick <code>search_evidence</code>, run it with{" "}
          <code>{`{ "query": "aspirin cardiovascular", "top_k": 5 }`}</code>.
        </li>
      </ol>

      <h2>Add as a connector</h2>
      <ul>
        <li>
          <strong>Claude.ai</strong> (free tier allows one): Settings → Connectors → Add custom
          connector → paste <code>{endpoint}</code>.
        </li>
        <li>
          <strong>ChatGPT / Claude Desktop / Cursor / Cline:</strong> add a remote MCP server with
          the same URL.
        </li>
      </ul>

      <h2>Verify with curl</h2>
      <pre><code>{`curl -X POST ${endpoint} \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2025-06-18","capabilities":{},
       "clientInfo":{"name":"curl","version":"0"}}}'`}</code></pre>

      <h2>Tools</h2>
      <ul>
        <li><code>search_evidence</code> — hybrid biomedical search with COI metadata + facet filters.</li>
        <li><code>get_paper</code> — fetch one document by canonical id (with citation neighborhood).</li>
        <li><code>get_trial</code> — single ClinicalTrials.gov / ICTRP record.</li>
        <li><code>get_trials_by_condition</code> — trials by condition, location, status, phase.</li>
        <li><code>get_recent_recalls</code> — recent FDA / EMA recall events.</li>
        <li><code>get_author_payments</code> — CMS Open Payments records for an author.</li>
        <li><code>get_citation_neighborhood</code> — walk the citation graph from one document.</li>
        <li><code>evaluate_evidence_quality</code> — per-document evidence-quality scorecard.</li>
      </ul>

      <h2>Rate limits</h2>
      <p>
        30 tool calls per minute per client. Returns an MCP <code>isError</code> response with a
        retry hint when exceeded.
      </p>

      <h2>Resources</h2>
      <p>
        Documents are also exposed as MCP resources under the URI template{" "}
        <code>evidencelens://document/{`{id}`}</code>, so clients that prefer the resource
        interface over tool calls can read them directly.
      </p>
    </article>
  );
}
