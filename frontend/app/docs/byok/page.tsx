export default function DocsByokPage() {
  return (
    <article className="mx-auto max-w-3xl px-4 py-12 prose">
      <div className="eyebrow mb-2">Bring Your Own Key</div>
      <h1>BYOK synthesis</h1>
      <p>
        EvidenceLens runs at $0 server-side LLM cost. The search engine is free and needs no key.
        To get a conversational synthesis on top of your results, you supply your own provider key.
        We proxy the request, stream the response back, and <strong>never store the key</strong>.
      </p>

      <h2>Supported providers</h2>
      <p>The settings panel offers a key field for:</p>
      <ul>
        <li><strong>Anthropic</strong> — Claude models, with prompt caching enabled by default.</li>
        <li><strong>OpenAI</strong> — GPT-4o / GPT-4o-mini.</li>
        <li>
          <strong>Groq</strong> — Llama 3.3 70B and others. Groq issues a free key with no card,
          so it's the cheapest way to try BYOK.
        </li>
      </ul>
      <p>
        The proxy also accepts other OpenAI-compatible endpoints (OpenRouter, Together, DeepInfra)
        and a self-hosted <strong>Ollama</strong> instance. If you don't want to use a key at all,
        switch to the <strong>WebLLM</strong> tier — inference runs entirely in your browser.
      </p>

      <h2>How it works</h2>
      <ol>
        <li>
          You paste your key in the settings panel. It is stored only in your browser's{" "}
          <code>localStorage</code> and never sent to EvidenceLens for storage.
        </li>
        <li>
          Each synthesis sends the key over TLS to <code>POST /llm/synthesize</code> on the gateway,
          as an <code>Authorization: Bearer</code> header alongside <code>x-provider</code> and an
          optional <code>x-model</code>. The gateway forwards to the agent service, which calls your
          chosen provider and streams Server-Sent Events back.
        </li>
        <li>
          The agent validates the key on first use with a cheap probe, then caches the result for
          10&nbsp;minutes keyed by <code>SHA-256(provider + key)</code>. Only provider, model,
          token counts, latency, and error codes are written to telemetry — never the key itself.
        </li>
      </ol>

      <h2>Why BYOK</h2>
      <p>
        This is a free public service on a small budget. Server-side LLM costs would scale with
        traffic and force aggressive rate limits or a shutdown. BYOK keeps the search engine
        permanently free while letting power users opt into whatever model and budget they prefer.
      </p>

      <h2>Privacy</h2>
      <p>
        Keys live in your browser and the in-memory request lifecycle of the proxy. They are not
        written to disk, not logged, not shared with third parties. If you'd rather not trust the
        proxy at all, use WebLLM and the entire interaction stays on your machine.
      </p>

      <h2>Rate limits</h2>
      <p>Synthesis is limited to 30 requests per minute per IP.</p>
    </article>
  );
}
