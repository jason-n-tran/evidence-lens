/**
 * WebLLM manual tool-use loop.
 *
 * @mlc-ai/web-llm doesn't expose Anthropic/OpenAI-style native tool
 * calling. We get the same outcome by:
 *   1. System-prompting the model to emit a tagged JSON object whenever
 *      it wants to call a tool.
 *   2. Parsing those tagged objects out of the streamed output.
 *   3. Dispatching them to the gateway via /api/tool/{name}.
 *   4. Re-prompting the model with the tool result and continuing.
 *
 * This is the WebLLM equivalent of the agent-service tool-use loop in
 * agent/main.py, mirrored client-side so the visitor's GPU does the
 * generation and the EvidenceLens server only sees tool dispatches.
 */

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8080";

const TOOL_RE = /<tool_use>([\s\S]*?)<\/tool_use>/g;

const TOOL_PROMPT = `You are EvidenceLens, an evidence-based biomedical search assistant.

You have access to these tools (call them by emitting a <tool_use>...</tool_use>
block containing JSON of the shape {"name":"...","arguments":{...}}):

- search_evidence(query, filters)
- get_paper(id)
- get_trial(id)
- get_trials_by_condition(condition, location, status, phase)
- get_recent_recalls(drug_class, product_name, since_days)
- get_author_payments(author_name, year)
- get_citation_neighborhood(id, depth)
- evaluate_evidence_quality(ids)

Hard rules: not medical advice, cite every claim with [N] referencing a tool
result, surface conflicts of interest, lead with study type and recency,
acknowledge uncertainty, link canonical_url for every citation.`;

interface ToolCall { name: string; arguments: Record<string, unknown> }

interface MLCEngine {
  chat: {
    completions: {
      create(opts: any): Promise<AsyncIterable<{ choices: Array<{ delta?: { content?: string }; message?: { content?: string } }> }>>;
    };
  };
}

interface MessageLike { role: "system" | "user" | "assistant" | "tool"; content: string }

export interface RunOpts {
  /** Initial visitor question. */
  query: string;
  /** Stream callback for partial assistant text. */
  onText: (chunk: string) => void;
  /** Per-tool-call notification (for UI badge). */
  onToolCall?: (call: ToolCall, result: unknown) => void;
  /** Hard cap on tool dispatch turns (default 6). */
  maxTurns?: number;
  /** Override the default system prompt. */
  systemPrompt?: string;
}

/**
 * Run one WebLLM session with the manual tool-use loop. Resolves when
 * the model emits a final assistant message with no remaining tool
 * blocks.
 */
export async function runWebLLM(engine: MLCEngine, opts: RunOpts): Promise<string> {
  const messages: MessageLike[] = [
    { role: "system", content: opts.systemPrompt ?? TOOL_PROMPT },
    { role: "user", content: opts.query },
  ];
  const maxTurns = opts.maxTurns ?? 6;

  for (let turn = 0; turn < maxTurns; turn++) {
    const stream = await engine.chat.completions.create({
      messages,
      stream: true,
      temperature: 0.2,
    });

    let assistantBuffer = "";
    for await (const chunk of stream) {
      const piece = chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? "";
      if (!piece) continue;
      assistantBuffer += piece;
    }

    const calls = extractToolCalls(assistantBuffer);
    messages.push({ role: "assistant", content: assistantBuffer });

    // Strip <tool_use> blocks before passing text to the UI so raw JSON
    // never reaches the user. Emit after the full buffer is collected so
    // we know which spans to suppress.
    const visibleText = assistantBuffer.replace(/<tool_use>[\s\S]*?<\/tool_use>/g, "").trim();
    if (visibleText) opts.onText(visibleText + "\n");

    if (calls.length === 0) {
      return assistantBuffer;
    }

    for (const call of calls) {
      const result = await dispatchTool(call);
      opts.onToolCall?.(call, result);
      messages.push({
        role: "tool",
        content: JSON.stringify({ tool: call.name, result: trimForContext(call, result) }),
      });
    }
  }

  return messages[messages.length - 1]?.content ?? "";
}

function extractToolCalls(text: string): ToolCall[] {
  const out: ToolCall[] = [];
  let m: RegExpExecArray | null;
  while ((m = TOOL_RE.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      if (typeof obj?.name === "string") {
        out.push({ name: obj.name, arguments: obj.arguments ?? {} });
      }
    } catch {
      /* skip malformed block */
    }
  }
  return out;
}

// Trim tool results to fit within the model's 4096-token context window.
// Full document objects from search results are ~300 tokens each; we keep
// only the fields the model needs for synthesis and cap at 5 results.
function trimForContext(call: ToolCall, result: unknown): unknown {
  if (call.name === "search_evidence") {
    const r = result as any;
    const hits = (r?.results ?? []).slice(0, 5).map((item: any) => {
      const doc = item.document ?? item;
      const abstract = typeof doc.abstract === "string" ? doc.abstract.slice(0, 300) : undefined;
      return {
        id:           doc.id,
        title:        doc.title,
        abstract,
        study_type:   doc.study_type   ?? doc.studyType,
        published_at: doc.published_at ?? doc.publishedAt,
        canonical_url:doc.canonical_url ?? doc.canonicalUrl,
        score:        item.final_score  ?? item.finalScore,
      };
    });
    return { results: hits, totalEstimated: r?.totalEstimated };
  }
  if (call.name === "evaluate_evidence_quality") {
    // Already compact; just cap the list.
    const r = result as any;
    return { results: (r?.results ?? []).slice(0, 5) };
  }
  return result;
}

async function dispatchTool(call: ToolCall): Promise<unknown> {
  try {
    const res = await fetch(`${GATEWAY_URL}/api/tool/${encodeURIComponent(call.name)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(call.arguments),
    });
    if (!res.ok) return { error: `tool ${call.name} failed: ${res.status}` };
    return await res.json();
  } catch (e) {
    return { error: (e as Error).message };
  }
}
