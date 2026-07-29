"use client";

import { useEffect, useState } from "react";
import { runWebLLM } from "../lib/webllm-tools";
import { useWebLLMStore } from "../lib/store";

/**
 * WebLLM setup: lazy-load the @mlc-ai/web-llm bundle on first activation
 * so the ~2GB Llama 3.2 3B weights aren't fetched until the user opts in.
 *
 * Manual tool-use loop lives in lib/webllm-tools.ts; this component
 * surfaces a "test" button that runs one round-trip end-to-end so
 * visitors can verify their browser + GPU + the gateway tool dispatch
 * all work before relying on it.
 */
export function WebLLMSetup() {
  const setStoreEngine = useWebLLMStore(s => s.setEngine);
  const storeEngine = useWebLLMStore(s => s.engine);
  const [progress, setProgress] = useState<string>("Not loaded.");
  const [loaded, setLoaded] = useState(false);
  const [engine, setEngine] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const [testOutput, setTestOutput] = useState<string>("");

  // On mount, reuse an engine that already exists for this session instead of
  // re-creating it. The engine lives in the Zustand store (and on a window
  // global) and survives client-side navigation; re-running CreateMLCEngine
  // would needlessly recompile WebGPU shaders + reload weights into GPU memory.
  // Only fall back to load() if no engine exists yet (and weights are cached).
  useEffect(() => {
    if (loaded) return;
    const existing = storeEngine ?? (typeof window !== "undefined" && (window as any).__evidencelens_webllm);
    if (existing) {
      setEngine(existing);
      setStoreEngine(existing);
      setLoaded(true);
      setProgress("Ready.");
      return;
    }
    if (localStorage.getItem("evidencelens_webllm_cached") === "1") {
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    const fromCache = localStorage.getItem("evidencelens_webllm_cached") === "1";
    setProgress(fromCache ? "Restoring from cache…" : "Initializing WebLLM (one-time ~2GB download)…");
    try {
      const { CreateMLCEngine } = await import("@mlc-ai/web-llm");
      const e = await CreateMLCEngine("Llama-3.2-3B-Instruct-q4f16_1-MLC", {
        initProgressCallback: (r: any) =>
          setProgress(`${(r.progress * 100).toFixed(0)}% — ${r.text}`),
      });
      (window as any).__evidencelens_webllm = e;
      localStorage.setItem("evidencelens_webllm_cached", "1");
      setEngine(e);
      setStoreEngine(e);
      setLoaded(true);
      setProgress("Ready.");
    } catch (err) {
      setProgress(`Failed: ${(err as Error).message}`);
    }
  }

  async function test() {
    if (!engine) return;
    setTesting(true);
    setTestOutput("");
    try {
      await runWebLLM(engine, {
        query:
          "What is the most cited recent RCT for SGLT2 inhibitors in heart failure? Use the search tool.",
        onText: (chunk) => setTestOutput((prev) => prev + chunk),
        onToolCall: (call, result) => {
          const count = Array.isArray((result as any)?.results)
            ? `${(result as any).results.length} results`
            : (result as any)?.error
            ? `error: ${(result as any).error}`
            : "ok";
          setTestOutput((prev) => prev + `[tool: ${call.name} → ${count}]\n`);
        },
      });
    } catch (e) {
      setTestOutput((prev) => prev + `\n[error] ${(e as Error).message}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-2 text-sm">
      <button
        type="button"
        onClick={load}
        disabled={loaded}
        className="rounded bg-[hsl(var(--accent))] text-white px-3 py-1 disabled:opacity-50"
      >
        {loaded ? "Loaded" : "Download model & start"}
      </button>
      <p role="status" aria-live="polite" className="text-xs text-[hsl(var(--muted))]">
        {progress}
      </p>
      {loaded && (
        <>
          <button
            type="button"
            onClick={test}
            disabled={testing}
            className="rounded border border-[hsl(var(--accent))] text-[hsl(var(--accent))] px-3 py-1 disabled:opacity-50"
          >
            {testing ? "Running…" : "Run sample query"}
          </button>
          {testOutput && (
            <pre className="text-xs bg-[hsl(var(--muted)/0.1)] p-2 rounded whitespace-pre-wrap max-h-64 overflow-auto">
              {testOutput}
            </pre>
          )}
        </>
      )}
      <p className="text-xs text-[hsl(var(--muted))]">
        Model weights served from our self-hosted MinIO bucket, cached in your browser after first load.
      </p>
    </div>
  );
}
