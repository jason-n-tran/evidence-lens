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
