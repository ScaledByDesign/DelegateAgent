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
 */
export async function resolveLLMKeysFromDelegate(
  workspaceId?: string | null,
  userId?: string | null,
): Promise<{
  mode: 'api_key' | 'oauth';
  oauthToken?: string;
  anthropicKey?: string;
  openaiKey?: string;
  anthropicBaseUrl?: string;
  systemAnthropicKey?: string;
  systemAnthropicBaseUrl?: string;
  pickedScope?: 'personal' | 'workspace' | 'system';
} | null> {
  if (!DELEGATE_AGENT_TOKEN) return null;
  try {
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspaceId', workspaceId);
    if (userId) params.set('userId', userId);
    const res = await fetch(
      `${DELEGATE_URL}/api/agent/integrations/llm-keys?${params}`,
      {
        headers: { Authorization: `Bearer ${DELEGATE_AGENT_TOKEN}` },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    const payload = data?.data;
    if (!payload) return null;
    // Default `mode` to 'api_key' for back-compat with old Delegate deploys
    // that don't emit the field. New deploys always set it explicitly.
    return {
      mode: payload.mode === 'oauth' ? 'oauth' : 'api_key',
      oauthToken: payload.oauthToken,
      anthropicKey: payload.anthropicKey,
      openaiKey: payload.openaiKey,
      anthropicBaseUrl: payload.anthropicBaseUrl,
      systemAnthropicKey: payload.systemAnthropicKey,
      systemAnthropicBaseUrl: payload.systemAnthropicBaseUrl,
      pickedScope: payload.pickedScope,
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
