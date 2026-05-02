// ─── Bifrost client for chat fast-path ───
//
// Calls Bifrost's `/anthropic/v1/messages` endpoint directly, bypassing the
// Claude Agent SDK + Docker container. Used by the chat dispatch path for
// short conversational messages where the agent doesn't need tools.
//
// Bifrost upstream is configured (see scaledbydesign/Delegate
// `.omc/notepads`/memory) to route Anthropic-shaped traffic through the
// `openrouter-anthropic` provider, so this single call honors the same
// failover chain as container-spawned agent runs.

const BIFROST_URL = (
  process.env.BIFROST_URL || "http://localhost:4000"
).replace(/\/$/, "");

const DEFAULT_MODEL = process.env.CHAT_FAST_PATH_MODEL || "claude-sonnet-4-6";
const REQUEST_TIMEOUT_MS = parseInt(
  process.env.CHAT_FAST_PATH_TIMEOUT_MS || "20000",
  10,
);

export interface ChatBifrostRequest {
  /** System prompt — task title/description + agent persona context. */
  system: string;
  /** User-facing message to respond to. */
  userMessage: string;
  /** Optional prior turns for conversational context. */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface ChatBifrostResponse {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Single-turn chat completion via Bifrost. Throws on transport / non-2xx
 * so the caller can fall through to the container path.
 */
export async function chatComplete(
  req: ChatBifrostRequest,
): Promise<ChatBifrostResponse> {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...(req.history ?? []),
    { role: "user", content: req.userMessage },
  ];

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${BIFROST_URL}/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        system: req.system,
        messages,
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Bifrost ${res.status}: ${body.slice(0, 200) || res.statusText}`,
    );
  }

  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const text = (data.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");

  if (!text.trim()) {
    throw new Error("Bifrost returned empty content");
  }

  return {
    text,
    model: data.model || DEFAULT_MODEL,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  };
}
