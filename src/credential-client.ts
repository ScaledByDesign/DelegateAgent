// ─── Delegate Credential Client ───
// Resolves per-workspace tokens from Delegate's integration API.
// Two-tier strategy: no caching — each request gets a fresh token.
// Used by the orchestrator for git operations (clone, fetch) when
// the token wasn't provided in the request body.

import { sanitizeGitUrl } from "./git-auth.js";

const DELEGATE_URL = process.env.DELEGATE_URL || "https://delegate.ws";
const DELEGATE_API_KEY = process.env.DELEGATE_API_KEY || "";

/**
 * Resolve LLM API keys for a workspace (Anthropic, OpenAI, etc.)
 * Used to inject API keys into agent containers so Claude Code can authenticate.
 * Returns { anthropicKey?, openaiKey?, anthropicBaseUrl? }
 */
export async function resolveLLMKeysFromDelegate(
  workspaceId?: string | null,
  userId?: string | null
): Promise<{
  anthropicKey?: string;
  openaiKey?: string;
  anthropicBaseUrl?: string;
  systemAnthropicKey?: string;
  systemAnthropicBaseUrl?: string;
} | null> {
  if (!DELEGATE_API_KEY) return null;
  try {
    const params = new URLSearchParams();
    if (workspaceId) params.set("workspaceId", workspaceId);
    if (userId) params.set("userId", userId);
    const res = await fetch(
      `${DELEGATE_URL}/api/agent/integrations/llm-keys?${params}`,
      {
        headers: { Authorization: `Bearer ${DELEGATE_API_KEY}` },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    return data?.data || null;
  } catch (e) {
    console.error(
      `[credential-client] LLM key resolution failed: ${(e as Error).message}`
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
  provider: string = "github"
): Promise<string | null> {
  if (!workspaceId || !DELEGATE_API_KEY) return null;
  try {
    const res = await fetch(
      `${DELEGATE_URL}/api/agent/integrations/token?provider=${provider}&workspaceId=${workspaceId}`,
      {
        headers: { Authorization: `Bearer ${DELEGATE_API_KEY}` },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    return data?.data?.token || null;
  } catch (e) {
    // SECURITY: never log full URLs (could contain tokens in other contexts)
    console.error(
      `[credential-client] Token resolution failed for workspace ${workspaceId}: ${(e as Error).message}`
    );
    return null;
  }
}
