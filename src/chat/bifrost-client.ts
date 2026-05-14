// ─── Bifrost client for chat fast-path (with OAuth-first failover) ───
//
// Two-tier failover for short conversational messages where the agent
// doesn't need tools:
//
//   Tier 1 — Personal/workspace Anthropic OAuth token  (api.anthropic.com)
//   Tier 2 — Bifrost gateway                            (openrouter-anthropic
//                                                        + Anthropic direct
//                                                        load-balanced upstream)
//
// Tier 1 is tried first when `CHAT_FASTPATH_OAUTH_TOKEN` is set on the
// droplet — this preserves zero added latency on the success path while
// letting personal Claude Code OAuth tokens absorb the chat load. On
// network failure / non-2xx / 429 / 5xx / empty content, falls through to
// Tier 2 (Bifrost). Tier 2 itself load-balances across providers via the
// openrouter-anthropic Bifrost config (see bifrost_two_layer_model_acl
// memory + bifrost_no_vk_lockdown_2026_05_11 memory).

const BIFROST_VK =
  process.env.BIFROST_VK || process.env.ANTHROPIC_API_KEY || '';

const BIFROST_URL = (
  process.env.BIFROST_URL || 'http://localhost:4000'
).replace(/\/$/, '');

/**
 * Personal/workspace Anthropic OAuth token for the chat fastpath's Tier 1.
 * Format `sk-ant-oat01-...`. When set, every chat fastpath call tries direct
 * Anthropic first; on any failure it falls over to Bifrost. When unset, the
 * fastpath goes straight to Bifrost as before.
 *
 * Set on the droplet via `secrets.env` (per droplet_ops.md). DO NOT commit
 * the token — only the env-var name.
 */
const FASTPATH_OAUTH_TOKEN =
  process.env.CHAT_FASTPATH_OAUTH_TOKEN ||
  process.env.CLAUDE_CODE_OAUTH_TOKEN ||
  '';

const ANTHROPIC_DIRECT_URL = 'https://api.anthropic.com/v1/messages';

const DEFAULT_MODEL = process.env.CHAT_FAST_PATH_MODEL || 'claude-sonnet-4-6';
const REQUEST_TIMEOUT_MS = parseInt(
  process.env.CHAT_FAST_PATH_TIMEOUT_MS || '20000',
  10,
);

export interface ChatBifrostRequest {
  /** System prompt — task title/description + agent persona context. */
  system: string;
  /** User-facing message to respond to. */
  userMessage: string;
  /** Optional prior turns for conversational context. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /**
   * Per-call OAuth token for Tier 1. Resolved by the chat dispatch from the
   * inbound JID's workspace + user via Delegate's `/api/agent/integrations/llm-keys`
   * picker. When set, takes precedence over the droplet-wide env token.
   * Null/undefined → fall back to CHAT_FASTPATH_OAUTH_TOKEN env, then
   * Bifrost-only. Lets each chat call ride on the requesting user's
   * personal/workspace Anthropic OAuth token instead of a shared droplet token.
   */
  oauthToken?: string | null;
}

export interface ChatBifrostResponse {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Which failover tier handled the call. `oauth` = direct Anthropic via
   *  CHAT_FASTPATH_OAUTH_TOKEN; `bifrost` = the gateway. Used by the
   *  dispatch metrics surface (`recordFastpath('hit-oauth' | 'hit-bifrost')`). */
  via: 'oauth' | 'bifrost';
}

/**
 * Single-turn chat completion. Two-tier failover:
 *   1. Anthropic-direct via OAuth token (when `CHAT_FASTPATH_OAUTH_TOKEN`
 *      or `CLAUDE_CODE_OAUTH_TOKEN` is set on the droplet).
 *   2. Bifrost gateway (always — `openrouter-anthropic` upstream chain).
 *
 * Tier 1 transient/auth failures (network error, 401/403/429/5xx, empty
 * content) fall through to Tier 2 with a warning log. Both tiers throw on
 * exhaustion so the caller can escalate to the container path.
 *
 * Returns `via: 'oauth' | 'bifrost'` so the dispatch metrics can surface
 * which tier handled the call.
 */
export async function chatComplete(
  req: ChatBifrostRequest,
): Promise<ChatBifrostResponse> {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    ...(req.history ?? []),
    { role: 'user', content: req.userMessage },
  ];

  // ─── Tier 1: OAuth-direct Anthropic ─────────────────────────────────────
  // Per-call token (resolved per-workspace-user) takes precedence; falls
  // back to the droplet-wide env token; Tier 1 stays inert when both are
  // empty.
  const tier1Token = req.oauthToken ?? FASTPATH_OAUTH_TOKEN;
  if (tier1Token) {
    try {
      return await chatCompleteAnthropicDirect(
        tier1Token,
        req.system,
        messages,
      );
    } catch (err) {
      // Log + fall through to Bifrost. Don't escalate to container yet — the
      // gateway absorbs Anthropic-direct outages via the openrouter-anthropic
      // upstream.
      console.warn(
        `[chat-fastpath] OAuth tier failed, falling over to Bifrost: ${(err as Error).message}`,
      );
    }
  }

  // ─── Tier 2: Bifrost gateway ────────────────────────────────────────────
  return chatCompleteBifrost(req.system, messages);
}

/**
 * Tier 1 — call `https://api.anthropic.com/v1/messages` directly with a
 * personal/workspace OAuth token. Mirrors the Bifrost-tier request shape
 * so the response decoder is identical.
 */
async function chatCompleteAnthropicDirect(
  oauthToken: string,
  system: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<ChatBifrostResponse> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_DIRECT_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        // OAuth tokens (`sk-ant-oat01-...`) authenticate via Authorization
        // bearer header, NOT `x-api-key`. Workspace API keys (`sk-ant-...`)
        // would use `x-api-key` instead; we only configure OAuth here.
        authorization: `Bearer ${oauthToken}`,
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        system,
        messages,
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Anthropic-direct ${res.status}: ${body.slice(0, 200) || res.statusText}`,
    );
  }

  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const text = (data.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');

  if (!text.trim()) {
    throw new Error('Anthropic-direct returned empty content');
  }

  return {
    text,
    model: data.model || DEFAULT_MODEL,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    via: 'oauth',
  };
}

/**
 * Tier 2 — Bifrost gateway. Bifrost's `openrouter-anthropic` provider
 * load-balances across upstream Anthropic + OpenRouter so this single
 * call absorbs the same failover chain as container-spawned agent runs.
 */
async function chatCompleteBifrost(
  system: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<ChatBifrostResponse> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${BIFROST_URL}/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(BIFROST_VK ? { 'x-bf-vk': BIFROST_VK } : {}),
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        system,
        messages,
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
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
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');

  if (!text.trim()) {
    throw new Error('Bifrost returned empty content');
  }

  return {
    text,
    model: data.model || DEFAULT_MODEL,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    via: 'bifrost',
  };
}
