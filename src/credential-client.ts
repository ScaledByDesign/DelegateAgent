// ─── Delegate Credential Client ───
// Resolves per-workspace tokens from Delegate's integration API.
// Two-tier strategy: no caching — each request gets a fresh token.
// Used by the orchestrator for git operations (clone, fetch) when
// the token wasn't provided in the request body.

import { sanitizeGitUrl } from './git-auth.js';
import { getEnvWithFallback } from './config.js';

const DELEGATE_URL = process.env.DELEGATE_URL || 'https://delegate.ws';
// Canonical: DELEGATE_AGENT_TOKEN. Legacy fallback: DELEGATE_API_KEY.
const DELEGATE_AGENT_TOKEN =
  getEnvWithFallback('DELEGATE_AGENT_TOKEN', ['DELEGATE_API_KEY']) || '';

/**
 * Discriminated union representing the resolved LLM credential outcome.
 *
 *   - `{ mode: 'oauth', oauthToken: string, providerId: string, pickedScope: 'personal'|'workspace' }`
 *     → inject CLAUDE_CODE_OAUTH_TOKEN. Do NOT inject ANTHROPIC_API_KEY or
 *     ANTHROPIC_BASE_URL — OAuth speaks api.anthropic.com directly.
 *     `providerId` is the LLMProvider row id for cooldown reporting back to
 *     Delegate when the container observes a 429.
 *
 *   - `{ mode: 'api_key', anthropicKey: string, pickedScope: 'personal'|'workspace'|'system' }`
 *     → inject ANTHROPIC_API_KEY + optionally ANTHROPIC_BASE_URL / system keys.
 *     `providerId` may be present (pool-enabled rows) but is optional.
 *
 *   - `{ mode: 'oauth', oauthToken: null, pickedScope: 'exhausted' }`
 *     → workspace is in OAuth mode but ALL tokens are cooling down. The caller
 *     MUST hard-fail (oauthHardFail path) — do not fall through to Bifrost.
 *
 * Back-compat: if upstream Delegate omits `mode` (pre-Phase-3 deploys), the
 * field is normalised to `'api_key'` so existing callers keep working unchanged.
 */
/**
 * Funded fallback credential the container retries against when the primary
 * Claude credential returns a 402/429. Ordered by the AI Models waterfall.
 * Bifrost does not fall back on 4xx, so this cascade lives in the container.
 */
export interface LLMFallbackCredential {
  provider: string; // "openai" | "gemini" | …
  key: string;
  baseUrl: string | null;
}

export type ResolvedLLMKeys =
  | {
      mode: 'oauth';
      oauthToken: string;
      providerId: string;
      openaiKey?: string;
      fallbacks?: LLMFallbackCredential[];
      pickedScope: 'personal' | 'workspace';
    }
  | {
      mode: 'api_key';
      anthropicKey: string;
      anthropicBaseUrl?: string | null;
      providerId?: string;
      openaiKey?: string;
      systemAnthropicKey?: string;
      systemAnthropicBaseUrl?: string | null;
      fallbacks?: LLMFallbackCredential[];
      pickedScope: 'personal' | 'workspace' | 'system';
    }
  | { mode: 'oauth'; oauthToken: null; pickedScope: 'exhausted' };

/**
 * Resolve LLM API keys for a workspace (Anthropic, OpenAI, etc.).
 *
 * Used to inject API keys (or OAuth tokens) into agent containers so Claude
 * Code can authenticate. Phase 5 (credential-mode-toggle plan) extends the
 * response with a `mode` discriminator:
 *
 *   - `mode: 'api_key'`  → use `anthropicKey` + optional `anthropicBaseUrl`
 *     (Bifrost VK or workspace-supplied custom URL).
 *   - `mode: 'oauth'`    → use `oauthToken` as CLAUDE_CODE_OAUTH_TOKEN. The
 *     caller MUST NOT inject ANTHROPIC_API_KEY or ANTHROPIC_BASE_URL in this
 *     mode — OAuth speaks api.anthropic.com directly.
 *
 * Phase 6 (oauth-key-pool plan): `providerId` is included in successful oauth
 * resolutions so the in-container 429 hook can call
 * `reportLLMCooldown({ providerId, workspaceId, reason })` back to Delegate.
 * When ALL workspace OAuth tokens are cooling, `pickedScope='exhausted'` and
 * `oauthToken=null` is returned — the caller MUST hard-fail.
 *
 * Picker scope: Delegate's `pickAnthropicCredential` runs a 4-tier chain
 * (personal-user override → workspace default → system Bifrost → none). The
 * winning tier is surfaced via `pickedScope` for diagnostics / metrics labels.
 *
 * Back-compat: if the upstream Delegate response omits `mode` (older deploys
 * pre-Phase-3), the field is filled in as `'api_key'` so existing callers
 * keep working unchanged.
 *
 * @param workspaceId - Workspace whose credentials should be resolved.
 * @param userId      - The requesting user (Phase 5 per-user override). When
 *                      undefined the picker resolves only workspace-default
 *                      and system tiers.
 * @param agentJwt    - Per-workspace agent JWT (minted via mintAgentJWT) to
 *                      present as the Authorization bearer. REQUIRED for the
 *                      JWT-only credential route as of the platform's Phase 7
 *                      Sub-step 7.7b cutover — `/api/agent/integrations/llm-keys`
 *                      hard-rejects the legacy shared bearer with 401
 *                      (CREDENTIAL_ROUTE_LEGACY_BEARER_REJECTED) unless the
 *                      platform's `legacy_bearer_acceptance_window_enabled`
 *                      escape hatch is open. When omitted we fall back to the
 *                      legacy DELEGATE_AGENT_TOKEN bearer (works only while the
 *                      escape hatch is active — emits a 401 otherwise).
 */
export async function resolveLLMKeysFromDelegate(
  workspaceId?: string | null,
  userId?: string | null,
  agentJwt?: string | null,
): Promise<ResolvedLLMKeys | null> {
  // The JWT-only credential route needs a per-workspace JWT. If neither a
  // minted JWT nor the legacy bootstrap bearer is available, we cannot auth.
  if (!agentJwt && !DELEGATE_AGENT_TOKEN) return null;
  try {
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspaceId', workspaceId);
    if (userId) params.set('userId', userId);
    // Prefer the per-workspace JWT (accepted by the JWT-only route). Fall back
    // to the legacy shared bearer only when no JWT was minted.
    const bearer = agentJwt || DELEGATE_AGENT_TOKEN;
    const res = await fetch(
      `${DELEGATE_URL}/api/agent/integrations/llm-keys?${params}`,
      {
        headers: { Authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    const payload = data?.data;
    if (!payload) return null;

    const isOauthMode = payload.mode === 'oauth';

    // Exhausted pool: workspace is in OAuth mode but all tokens cooling down.
    if (
      isOauthMode &&
      payload.oauthToken === null &&
      payload.pickedScope === 'exhausted'
    ) {
      return { mode: 'oauth', oauthToken: null, pickedScope: 'exhausted' };
    }

    // Normalize the funded fallback bundle (OpenAI/Gemini) if present. Older
    // Delegate deploys omit it → undefined (no in-run cascade, cooldown-only).
    const fallbacks: LLMFallbackCredential[] | undefined = Array.isArray(
      payload.fallbacks,
    )
      ? payload.fallbacks
          .filter(
            (f: any) =>
              f && typeof f.provider === 'string' && typeof f.key === 'string',
          )
          .map((f: any) => ({
            provider: f.provider as string,
            key: f.key as string,
            baseUrl: (f.baseUrl ?? null) as string | null,
          }))
      : undefined;

    // OAuth success: token present.
    if (isOauthMode && payload.oauthToken) {
      return {
        mode: 'oauth',
        oauthToken: payload.oauthToken as string,
        providerId: payload.providerId as string,
        openaiKey: payload.openaiKey,
        fallbacks,
        pickedScope:
          payload.pickedScope === 'personal' ? 'personal' : 'workspace',
      };
    }

    // api_key branch (or back-compat with old Delegate that omits `mode`).
    return {
      mode: 'api_key',
      anthropicKey: payload.anthropicKey,
      anthropicBaseUrl: payload.anthropicBaseUrl,
      providerId: payload.providerId,
      openaiKey: payload.openaiKey,
      systemAnthropicKey: payload.systemAnthropicKey,
      systemAnthropicBaseUrl: payload.systemAnthropicBaseUrl,
      fallbacks,
      pickedScope: payload.pickedScope ?? 'system',
    };
  } catch (e) {
    console.error(
      `[credential-client] LLM key resolution failed: ${(e as Error).message}`,
    );
    return null;
  }
}

/**
 * Resolve a fresh git token from Delegate API.
 * No caching — each request gets a fresh token to handle OAuth expiry.
 */
export async function resolveTokenFromDelegate(
  workspaceId?: string | null,
  provider: string = 'github',
): Promise<string | null> {
  if (!workspaceId || !DELEGATE_AGENT_TOKEN) return null;
  try {
    const res = await fetch(
      `${DELEGATE_URL}/api/agent/integrations/token?provider=${provider}&workspaceId=${workspaceId}`,
      {
        headers: { Authorization: `Bearer ${DELEGATE_AGENT_TOKEN}` },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    return data?.data?.token || null;
  } catch (e) {
    // SECURITY: never log full URLs (could contain tokens in other contexts)
    console.error(
      `[credential-client] Token resolution failed for workspace ${workspaceId}: ${(e as Error).message}`,
    );
    return null;
  }
}
