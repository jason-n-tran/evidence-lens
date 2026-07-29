"use client";

import { useEffect, useState } from "react";
import { useByokStore } from "../lib/store";
import { ByokKeyManager } from "./ByokKeyManager";
import { WebLLMSetup } from "./WebLLMSetup";
import { McpSetup } from "./McpSetup";

type Tier = "byok" | "mcp" | "webllm";

export function TierPicker() {
  const tier = useByokStore(s => s.tier);
  const setTier = useByokStore(s => s.setTier);

  return (
    <section aria-labelledby="tier-h" className="panel p-4 space-y-3">
      <h2 id="tier-h" className="eyebrow">Choose how to synthesize answers</h2>
      <div role="radiogroup" aria-label="Inference tier" className="flex flex-col gap-2 text-sm">
        {(["webllm", "mcp", "byok"] as Tier[]).map(t => (
          <label
            key={t}
            className={
              "flex items-start gap-2.5 rounded-md border p-2.5 cursor-pointer transition-colors " +
              (tier === t
                ? "border-[hsl(var(--accent))] bg-[hsl(var(--accent)/0.06)]"
                : "border-[hsl(var(--rule))] hover:border-[hsl(var(--rule-strong))]")
            }
          >
            <input type="radio" name="tier" value={t} checked={tier === t} onChange={() => setTier(t)} className="mt-0.5 accent-[hsl(var(--accent))]" />
            <span>
              <strong className="font-sans">{t === "byok" ? "Bring Your Own Key" : t === "mcp" ? "Model Context Protocol" : "In-browser (WebLLM)"}</strong>
              <br />
              <span className="text-[hsl(var(--muted))] text-xs">
                {t === "byok" && "Paste your Anthropic / OpenAI / Groq key. Stored in your browser only."}
                {t === "mcp" && "Connect Claude, ChatGPT, or any MCP client to our public tool server. Free, no key."}
                {t === "webllm" && "Llama 3.2 3B runs on your GPU. ~2GB download once."}
              </span>
            </span>
          </label>
        ))}
      </div>
      {tier === "byok" && <ByokKeyManager />}
      {tier === "mcp" && <McpSetup />}
      {tier === "webllm" && <WebLLMSetup />}
    </section>
  );
}
