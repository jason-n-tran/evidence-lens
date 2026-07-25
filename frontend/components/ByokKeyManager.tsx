"use client";

import { useEffect, useState } from "react";
import { useByokStore } from "../lib/store";

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8080";

// Only the providers the UI offers a key field for. The gateway catalog also
// lists ollama, but that's a self-hosted base URL, not a pasted key.
const PROVIDERS = [
  { id: "anthropic", label: "Anthropic", url: "https://console.anthropic.com/settings/keys" },
  { id: "openai",    label: "OpenAI",    url: "https://platform.openai.com/api-keys" },
  { id: "groq",      label: "Groq",      url: "https://console.groq.com/keys" },
];

// Shape of each entry from the gateway's /llm/models catalog.
interface ModelInfo {
  id: string;            // provider id, e.g. "groq"
  displayName: string;
  defaultModel: string;
  models: string[];
}

export function ByokKeyManager() {
  const { provider, key, model, setProvider, setKey, setModel } = useByokStore();
  const [catalog, setCatalog] = useState<ModelInfo[] | null>(null);

  // Fetch the provider/model catalog once. Falls back to "default model only"
  // if the gateway is unreachable (the picker just hides; synthesis still works
  // because an empty model => agent uses the provider default).
  useEffect(() => {
    let cancelled = false;
    fetch(`${GATEWAY_URL}/llm/models`)
      .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: ModelInfo[]) => { if (!cancelled) setCatalog(d); })
      .catch(() => { if (!cancelled) setCatalog(null); });
    return () => { cancelled = true; };
  }, []);

  const entry = catalog?.find(c => c.id === provider);
  const models = entry?.models ?? [];
  const defaultModel = entry?.defaultModel ?? "";

  return (
    <div className="space-y-2 text-sm">
      <label className="block">
        Provider
        <select
          value={provider} onChange={(e) => setProvider(e.target.value as any)}
          className="ml-2 border rounded px-2 py-1 bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
        >
          {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>

      {/* Model picker — only when the catalog gave us choices for this provider.
          "" selects the provider default; the agent resolves it server-side. */}
      {models.length > 0 && (
        <label className="block">
          Model
          <select
            value={model} onChange={(e) => setModel(e.target.value)}
            className="ml-2 border rounded px-2 py-1 bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
          >
            <option value="">
              Default{defaultModel ? ` (${defaultModel})` : ""}
            </option>
            {models.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
      )}

      <label className="block">
        API key
        <input
          type="password" value={key} onChange={(e) => setKey(e.target.value)}
          placeholder="sk-..." autoComplete="off"
          className="block w-full border rounded px-2 py-1 bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
        />
      </label>
      <p className="text-xs text-[hsl(var(--muted))]">
        Your key is stored in this browser only (localStorage). EvidenceLens never sees or stores it.
        It is sent only to your chosen provider via our LLM proxy. Get a key from{" "}
        <a className="underline" href={PROVIDERS.find(p => p.id === provider)?.url} rel="noopener noreferrer" target="_blank">
          {provider}
        </a>.
      </p>
      <p className="text-xs text-[hsl(var(--muted))]">
        Tip: <strong>Groq</strong> offers a free API key (no card) — the cheapest way to try BYOK.
      </p>
    </div>
  );
}
