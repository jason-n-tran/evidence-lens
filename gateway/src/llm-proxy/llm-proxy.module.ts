import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Headers,
  HttpException, Module, Post, Req, Res,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";

import { TurnstileModule, TurnstileService } from "../turnstile/turnstile.module.js";

const SUPPORTED = new Set([
  "anthropic", "openai", "groq", "openrouter", "together", "deepinfra", "ollama",
]);

@Controller("llm")
class LlmProxyController {
  constructor(private readonly turnstile: TurnstileService) {}

  @Get("status")
  status() {
    return { turnstile: this.turnstile.enabled };
  }

  @Get("models")
  async models() {
    // Catalog. Frontend renders these in TierPicker.
    return [
      { id: "anthropic", displayName: "Anthropic", apiShape: "anthropic", supportsPromptCaching: true,
        defaultModel: "claude-opus-4-7", models: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
        setupUrl: "https://console.anthropic.com/settings/keys" },
      { id: "openai", displayName: "OpenAI", apiShape: "openai_compatible", supportsPromptCaching: false,
        defaultModel: "gpt-4o-mini", models: ["gpt-4o-mini", "gpt-4o"],
        setupUrl: "https://platform.openai.com/api-keys" },
      { id: "groq", displayName: "Groq", apiShape: "openai_compatible", supportsPromptCaching: false,
        defaultModel: "llama-3.3-70b-versatile", models: ["llama-3.3-70b-versatile", "mixtral-8x7b-32768"],
        setupUrl: "https://console.groq.com/keys" },
      { id: "ollama", displayName: "Ollama (self-hosted)", apiShape: "ollama", supportsPromptCaching: false,
        defaultModel: "llama3.2", models: [], setupUrl: "https://ollama.com" },
    ];
  }

  @Post("synthesize")
  @Throttle({ llm: { ttl: 60_000, limit: 30 } })
  async synthesize(
    @Headers("authorization") auth: string,
    @Headers("x-turnstile-token") turnstileToken: string,
    @Headers("x-provider") provider: string,
    @Headers("x-model") model: string | undefined,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!auth?.startsWith("Bearer ")) {
      throw new BadRequestException("Authorization: Bearer <key> required");
    }
    if (this.turnstile.enabled) {
      const ok = await this.turnstile.verify(turnstileToken, req.ip);
      if (!ok) throw new ForbiddenException("Turnstile validation failed");
    }
    if (!SUPPORTED.has(provider)) {
      throw new BadRequestException(`unsupported provider ${provider}`);
    }
    // Forward to agent-service over HTTP+SSE. Stream-relay back to the
    // visitor, never log the key.
    const agentUrl = process.env.AGENT_URL ?? "http://agent:8081/synthesize";
    const upstream = await fetch(agentUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": auth,
        "x-provider": provider,
        ...(model ? { "x-model": model } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!upstream.ok || !upstream.body) {
      throw new HttpException(`agent upstream ${upstream.status}`, upstream.status);
    }
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  }
}

@Module({
  imports: [TurnstileModule],
  controllers: [LlmProxyController],
})
export class LlmProxyModule {}
