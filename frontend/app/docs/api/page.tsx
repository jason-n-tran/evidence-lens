export default function DocsApiPage() {
  return (
    <article className="mx-auto max-w-3xl px-4 py-12 prose">
      <div className="eyebrow mb-2">REST · GraphQL · WebSocket</div>
      <h1>Query API</h1>
      <p>
        The query gateway exposes three transports against the same data plane: a REST surface for
        simple integrations, a GraphQL endpoint for typed clients, and a WebSocket channel for
        streamed result waves. All three are read-only and require no authentication.
      </p>

      <h2>Base URL</h2>
      <pre><code>https://evidencelens.mykpoplists.com</code></pre>
      <p>
        For local development the gateway runs at <code>http://localhost:8080</code>.
      </p>

      <h2>REST</h2>
      <p>
        OpenAPI 3.1 specification:{" "}
        <a href="https://github.com/evidencelens/evidencelens/blob/main/docs/api/openapi.yaml">
          docs/api/openapi.yaml
        </a>
        . Primary endpoints:
      </p>
      <ul>
        <li><code>GET /api/search?q=...&top_k=20</code> — synchronous hybrid search.</li>
        <li><code>GET /api/document/{`{id}`}</code> — single document by canonical id (e.g. <code>pubmed:12345678</code>).</li>
        <li><code>GET /api/facets</code> — study-type and MeSH facet values with counts.</li>
        <li><code>GET /api/trials</code> — trials filtered by condition, status, and phase.</li>
        <li><code>GET /api/recalls/recent?since_days=7</code> — recent FDA / EMA recall events.</li>
        <li><code>POST /api/tool/{`{name}`}</code> — invoke a named tool (used by the MCP server).</li>
      </ul>

      <h2>GraphQL</h2>
      <p>
        Endpoint <code>POST /graphql</code>. Schema lives at{" "}
        <a href="https://github.com/evidencelens/evidencelens/blob/main/gateway/src/schema.graphql">
          gateway/src/schema.graphql
        </a>{" "}
        and is part of the contracts freeze — schema changes require an{" "}
        <code>rfc-interface</code> PR.
      </p>

      <h2>WebSocket</h2>
      <p>
        Endpoint <code>wss://evidencelens.mykpoplists.com/ws</code>, subprotocol{" "}
        <code>evidencelens.v1</code>. Streams three result waves per query (5 + 10 + 35) so the UI
        can render the first hits while the long tail finishes. Full message catalog:{" "}
        <a href="https://github.com/evidencelens/evidencelens/blob/main/docs/api/websocket.md">
          docs/api/websocket.md
        </a>
        .
      </p>

      <h2>Rate limits</h2>
      <ul>
        <li>REST / GraphQL: 60 req/min per IP.</li>
        <li>WebSocket: 10 simultaneous connections per IP.</li>
        <li>Tool calls (REST or MCP): 30 calls/min per session.</li>
      </ul>
    </article>
  );
}
