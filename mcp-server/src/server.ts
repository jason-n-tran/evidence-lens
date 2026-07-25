/**
 * EvidenceLens MCP server (spec §5.8).
 *
 * Anthropic Model Context Protocol over three transports:
 *   - stdio                  — local clients (Claude Desktop, MCP Inspector)
 *   - Streamable HTTP /mcp   — the modern remote transport (single endpoint;
 *                              what Claude.ai custom connectors + ChatGPT use)
 *   - legacy HTTP+SSE /sse   — deprecated (spec 2025-03), kept for old clients
 *
 * Public endpoint (proxied by the gateway, no separate domain needed):
 *   https://evidencelens.mykpoplists.com/mcp
 * Discovery:
 *   https://evidencelens.mykpoplists.com/.well-known/mcp.json
 *
 * Tool dispatch proxies to the gateway's /api/tool/{name} endpoint so
 * the MCP server stays thin (no business logic) and the gateway remains
 * the single source of truth for tool semantics.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { request as undiciRequest } from "undici";

import { TOOLS, RESOURCE_URI_TEMPLATE } from "./tools.js";
import * as rateLimit from "./rate_limit.js";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:8080";

function makeServer(sessionId: string): Server {
  const server = new Server(
    { name: "evidencelens", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    // Per-session rate limit (spec section 13.3): 30 tool calls/min.
    const rl = rateLimit.check(sessionId);
    if (!rl.ok) {
      return {
        content: [{ type: "text", text: `rate limited: try again in ${rl.retryAfterSec}s` }],
        isError: true,
      };
    }

    const url = `${GATEWAY_URL}/api/tool/${encodeURIComponent(name)}`;
    const res = await undiciRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args ?? {}),
    });
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      return { content: [{ type: "text", text: `tool ${name} failed: ${res.statusCode} ${text}` }], isError: true };
    }
    const data = await res.body.json();
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  });

  // Resources also count toward the rate limit at half cost.
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{
      uri: RESOURCE_URI_TEMPLATE,
      name: "EvidenceLens documents",
      description: "Documents addressable as evidencelens://document/{id}",
      mimeType: "application/json",
    }],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const { uri } = req.params;
    const m = uri.match(/^evidencelens:\/\/document\/(.+)$/);
    if (!m) throw new Error(`unsupported resource uri: ${uri}`);
    const docId = decodeURIComponent(m[1]);
    const res = await undiciRequest(`${GATEWAY_URL}/api/document/${encodeURIComponent(docId)}`);
    const text = await res.body.text();
    return {
      contents: [{ uri, mimeType: "application/json", text }],
    };
  });

  return server;
}

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  // stdio sessions get a stable per-process sessionId for rate limiting.
  const server = makeServer(`stdio-${process.pid}`);
  await server.connect(transport);
  console.error("[mcp] stdio transport ready");
}

async function runHttp(port: number): Promise<void> {
  const app = express();
  const transports = new Map<string, SSEServerTransport>();

  app.get("/.well-known/mcp.json", (_req, res) => {
    res.json({
      schema_version: "2025-06",
      name: "evidencelens",
      description: "Free, public, agentic biomedical evidence search",
      // Advertise the modern transport first; keep the legacy SSE entry for
      // older clients that still look for it.
      transport: {
        type: "streamable-http",
        endpoint: "/mcp",
      },
      transports: [
        { type: "streamable-http", endpoint: "/mcp" },
        { type: "http+sse", endpoint: "/sse" },
      ],
    });
  });

  // --- Modern transport: Streamable HTTP at a single /mcp endpoint ---
  // Stateless: every request gets a fresh Server + transport (no session
  // affinity). This server only dispatches stateless tool/resource calls, so
  // there's no per-session state to keep — and statelessness makes it trivial
  // to sit behind the gateway proxy and to scale horizontally.
  async function handleStreamable(req: express.Request, res: express.Response): Promise<void> {
    // A per-request id for rate limiting (no MCP session id in stateless mode).
    const rlId = `http-${(req.headers["x-forwarded-for"] as string) ?? req.ip ?? randomUUID()}`;
    const server = makeServer(rlId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[mcp] streamable request error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "internal error" },
          id: null,
        });
      }
    }
  }

  app.post("/mcp", express.json(), handleStreamable);
  // GET /mcp is used by clients that open a server->client notification stream.
  // Stateless mode has nothing to stream, but handleRequest replies correctly
  // (405 Method Not Allowed) rather than leaving the client hanging.
  app.get("/mcp", handleStreamable);

  app.get("/sse", async (req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);
    res.on("close", () => {
      transports.delete(transport.sessionId);
      rateLimit.reset(transport.sessionId);
    });
    const server = makeServer(transport.sessionId);
    await server.connect(transport);
  });

  app.post("/messages", express.json(), async (req, res) => {
    const sessionId = String(req.query.sessionId ?? "");
    const transport = transports.get(sessionId);
    if (!transport) { res.status(404).end(); return; }
    await transport.handlePostMessage(req, res);
  });

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

  app.listen(port, () => console.log(`[mcp] http+sse listening on :${port}`));
}

const transport = process.env.MCP_TRANSPORT ?? "stdio";
if (transport === "http") {
  runHttp(parseInt(process.env.MCP_PORT ?? "8082", 10)).catch(err => {
    console.error("[mcp] fatal", err); process.exit(1);
  });
} else {
  runStdio().catch(err => { console.error("[mcp] fatal", err); process.exit(1); });
}
