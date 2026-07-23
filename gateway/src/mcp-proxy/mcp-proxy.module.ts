import { All, Controller, Get, Module, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";

// The mcp-server runs alongside the gateway on the VPS (Docker internal name).
// Public clients hit the gateway only, so the gateway relays /mcp to it. This
// keeps a single public entrypoint and needs no Traefik/proxy changes.
const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? "http://mcp-server:8082";

// Request headers worth forwarding to the MCP server. MCP's Streamable HTTP
// transport relies on `accept` (json vs text/event-stream negotiation) and the
// session/protocol headers; we also pass auth through for future-proofing.
const FORWARD_REQ_HEADERS = [
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "authorization",
  "last-event-id",
];

// Response headers worth returning to the client. content-type distinguishes a
// plain JSON reply from an SSE stream; the rest carry MCP session/protocol info.
const FORWARD_RES_HEADERS = [
  "content-type",
  "cache-control",
  "mcp-session-id",
  "mcp-protocol-version",
];

/**
 * Relays the public /mcp endpoint (and its discovery doc) to the internal
 * mcp-server. Mirrors the SSE-relay pattern in llm-proxy: forward the request,
 * then stream the upstream response body straight back so both plain-JSON and
 * text/event-stream replies work unchanged.
 */
@Controller()
class McpProxyController {
  @Get(".well-known/mcp.json")
  async wellKnown(@Res() res: Response): Promise<void> {
    await this.relay("GET", "/.well-known/mcp.json", {}, undefined, res);
  }

  // Streamable HTTP uses a single endpoint for POST (client->server messages)
  // and GET (optional server->client notification stream). Relay both.
  @All("mcp")
  async mcp(@Req() req: Request, @Res() res: Response): Promise<void> {
    const headers: Record<string, string> = {};
    for (const h of FORWARD_REQ_HEADERS) {
      const v = req.headers[h];
      if (typeof v === "string") headers[h] = v;
    }
    // req.body is parsed JSON for POSTs (express.json upstream); re-serialize.
    const body = req.method === "POST" && req.body != null
      ? JSON.stringify(req.body)
      : undefined;
    await this.relay(req.method, "/mcp", headers, body, res);
  }

  private async relay(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: string | undefined,
    res: Response,
  ): Promise<void> {
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${MCP_SERVER_URL}${path}`, { method, headers, body });
    } catch (e) {
      res.status(502).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: `mcp upstream unreachable: ${(e as Error).message}` },
        id: null,
      });
      return;
    }

    res.status(upstream.status);
    for (const h of FORWARD_RES_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }

    if (!upstream.body) { res.end(); return; }

    // Stream the body through unchanged — handles both a single JSON object and
    // a long-lived SSE stream identically.
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {
      /* client or upstream dropped; fall through to end() */
    }
    res.end();
  }
}

@Module({ controllers: [McpProxyController] })
export class McpProxyModule {}
