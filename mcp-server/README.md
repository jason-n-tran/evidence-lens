# mcp-server

Per spec §5.8. Implements [Anthropic Model Context Protocol](https://modelcontextprotocol.io) v2025-06 over **stdio** (Claude Desktop) and **HTTP+SSE** (remote clients).

## Tools (8)

Defined in [src/tools.ts](src/tools.ts) (the contracts-frozen catalog). Each tool dispatches to the gateway's `POST /api/tool/{name}` so the MCP server stays thin.

## Resources

Documents addressable as `evidencelens://document/{id}`.

## Discovery

`/.well-known/mcp.json` advertises the endpoint per the MCP discovery RFC.

## Connect from Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "evidencelens": {
      "command": "npx",
      "args": ["-y", "@evidencelens/mcp-server"]
    }
  }
}
```

Or for the remote HTTP+SSE endpoint (the container's HTTP/SSE transport on `:8082`, fronted by
your own host/reverse proxy — there is no Cloudflare Worker any more):

```json
{
  "mcpServers": {
    "evidencelens-remote": {
      "url": "https://<your-mcp-host>/sse"
    }
  }
}
```

## Run

```bash
npm install                                       # at the repo root
npm run start:dev --workspace mcp-server          # stdio transport (for Claude Desktop dev)
MCP_TRANSPORT=http npm run start:dev --workspace mcp-server   # http+sse on :8082
```
