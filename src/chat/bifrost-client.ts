// ─── Bifrost client for chat fast-path (per-workspace credential resolver) ───
//
// Phase 4 of `.omc/plans/agent-path-credential-failover.md`. chatComplete now
// resolves a TransportSpec per call via `resolveChatTransport({workspaceId,
// userId})`. The dispatch surface is an exhaustive switch on `transport.kind`
// with a TypeScript `never` exhaustiveness check, so future TransportSpec
// drift is caught at compile time.
//
// Variants:
//   - 'api_key'           → workspace's Anthropic key against a workspace-
//                           supplied URL (x-api-key) OR system Bifrost
//                           (x-bf-vk). The two sub-cases differ only in URL +
//                           which header carries the credential.
//   - 'bifrost-env'       → legacy env fallback (dev / self-hosted / no
//                           workspaceId). x-bf-vk from process.env BIFROST_VK.
//   - 'skip-to-container' → workspace resolves to OAuth mode. Fast-path
//                           defers to the container path (Architect Q1).
//                           chatComplete throws SkipToContainerError; NO
//                           api.anthropic.com fetch from fast-path.
//   - 'exhausted'         → workspace OAuth pool exhausted (Architect Q2 +
//                           AC-OAUTH-HARD-FAIL-NO-BIFROST). chatComplete
//                           throws CredentialsExhaustedError; NO fetch, NO
//                           Bifrost fallback.
//
// All env reads (BIFROST_URL, BIFROST_VK) live in credential-resolver.ts.
// This file has zero direct process.env credential reads — only the request
// timeout / model selector env knobs.

import {
  resolveChatTransport,
  CredentialsExhaustedError,
  SkipToContainerError,
  type TransportSpec,
} from './credential-resolver.js';
import { reportLLMCooldown } from '../cooldown-client.js';
import { classifyChatError } from './error-classifier.js';

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
   * Phase 0 of agent-path-credential-failover plan: workspace whose
   * credentials should be resolved for this call. When omitted, the resolver
   * returns kind='bifrost-env' (env-only legacy path). When present + a
   * Delegate bearer token is configured, runs the 4-tier credential picker.
   */
  workspaceId?: string | null;
  /**
   * Phase 0 of agent-path-credential-failover plan: requesting Delegate
   * user id, threaded into the resolver so personal-override scopes can
   * pick a per-user LLMProvider row.
   */
  userId?: string | null;
  /**
   * @deprecated Pre-Phase-4 OAuth-direct tier. Ignored by the new TransportSpec
   * dispatch — OAuth-mode workspaces now throw SkipToContainerError instead
   * of attempting api.anthropic.com directly (Architect Q1 verdict). The
   * field is retained on the request shape so existing callers (legacy
   * `dispatch.ts` resolver path) still type-check during Commit B → C
   * transition; Commit C drops the resolver indirection entirely.
   */
  oauthToken?: string | null;
}

export interface ChatBifrostResponse {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * Which TransportSpec variant actually served the request. Used by
   * dispatch.ts for the per-mode `recordFastpath('hit-api_key' |
   * 'hit-bifrost-env')` metric.
   */
  transportMode: 'api_key' | 'bifrost-env';
  /**
   * @deprecated Pre-Phase-4 dual-tier label. After Commit C, dispatch reads
   * `transportMode` directly. Retained one release for back-compat — maps
   * `'api_key' | 'bifrost-env'` → `'bifrost'` since neither is the now-
   * removed Anthropic-direct OAuth tier.
   */
  via: 'oauth' | 'bifrost';
}

/**
 * Resolve a fast-path transport spec, then dispatch a single chat completion
 * over the chosen path. The four-variant switch is exhaustive (TS `never`
 * check on `default`). Throws:
 *
 *   - `CredentialsExhaustedError` when the workspace OAuth pool is exhausted.
 *     Dispatch translates this to `reason='credentials-failure'`. NO fetch
 *     is made.
 *   - `SkipToContainerError` when the workspace resolves to OAuth mode. NO
 *     fetch is made — dispatch returns `reason='oauth-mode-container-only'`
 *     so the channel falls through to the container path which handles
 *     OAuth correctly via the Claude SDK.
 *   - `Error("<status>: <body>")` on non-2xx upstream responses (caller
 *     classifies via `classifyChatErrorFromError`).
 *
 * On `credit_exhausted` / `auth_invalid` upstream classification AND when
 * the transport is `api_key` with a known providerId, fires a
 * fire-and-forget `reportLLMCooldown` before re-throwing. The throw itself
 * surfaces as a generic Error message — dispatch's `classifyChatErrorFromError`
 * re-extracts the status/body for its own routing.
 */
export async function chatComplete(
  req: ChatBifrostRequest,
): Promise<ChatBifrostResponse> {
  const transport = await resolveChatTransport({
    workspaceId: req.workspaceId,
    userId: req.userId,
  });

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    ...(req.history ?? []),
    { role: 'user', content: req.userMessage },
  ];

  switch (transport.kind) {
    case 'exhausted':
      throw new CredentialsExhaustedError(transport.workspaceId);
    case 'skip-to-container':
      throw new SkipToContainerError(transport.workspaceId, transport.reason);
    case 'api_key':
    case 'bifrost-env':
      return await dispatchFetch(transport, req.system, messages);
    default: {
      // TS exhaustiveness check — if a new TransportSpec variant is added
      // without updating this switch, the line below fails to type-check.
      const _exhaustive: never = transport;
      throw new Error(
        `unreachable transport: ${(_exhaustive as { kind?: string })?.kind ?? '<unknown>'}`,
      );
    }
  }
}

async function dispatchFetch(
  transport: Extract<TransportSpec, { kind: 'api_key' | 'bifrost-env' }>,
  system: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<ChatBifrostResponse> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(transport.url, {
      method: 'POST',
      headers: transport.headers,
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
    const classification = classifyChatError({ status: res.status, body });

    // Fire-and-forget cooldown report on credit_exhausted / auth_invalid
    // when we know which LLMProvider row to mark. Only api_key transports
    // surface a providerId (bifrost-env is shared/system).
    if (
      classification.shouldReportCooldown &&
      transport.kind === 'api_key' &&
      transport.providerId
    ) {
      const reason: 'usage_limit_exceeded' | 'auth_error' =
        classification.kind === 'credit_exhausted'
          ? 'usage_limit_exceeded'
          : 'auth_error';
      void Promise.resolve().then(() =>
        reportLLMCooldown({
          providerId: transport.providerId!,
          workspaceId: transport.workspaceId,
          reason,
        }).catch(() => {
          /* fire-and-forget; cooldown failure must not block the throw */
        }),
      );
    }

    throw new Error(
      `${transport.kind === 'api_key' ? 'Anthropic-direct' : 'Bifrost'} ${res.status}: ${
        body.slice(0, 200) || res.statusText
      }`,
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
    throw new Error(
      `${transport.kind === 'api_key' ? 'Anthropic-direct' : 'Bifrost'} returned empty content`,
    );
  }

  return {
    text,
    model: data.model || DEFAULT_MODEL,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    transportMode: transport.kind,
    via: 'bifrost',
  };
}
