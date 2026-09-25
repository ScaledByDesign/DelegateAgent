// ─── Delegate Cooldown Reporter ───
// POSTs to /api/agent/integrations/llm-keys/cooldown when the in-container
// Claude SDK returns a 429 (rate_limit_error / usage_limit_exceeded).
// Delegate marks the row's cooldown_until + cooldown_count; next picker
// resolution skips it.
//
// Auth: mints a per-workspace JWT via agentFetch (falls back to legacy bearer
// DELEGATE_AGENT_TOKEN if mint fails — matches dual-accept core side).

import { getEnvWithFallback } from './config.js';
import { fetchWithRetry5xx } from './retry-fetch.js';
import { mintAgentJWT } from './jwt-mint.js';

const DELEGATE_URL = process.env.DELEGATE_URL || 'https://delegate.ws';
// Legacy fallback bearer — used when JWT mint fails.
const DELEGATE_AGENT_TOKEN =
  getEnvWithFallback('DELEGATE_AGENT_TOKEN', ['DELEGATE_API_KEY']) || '';

/**
 * Report an LLM provider cooldown event to Delegate.
 *
 * Call this when the in-container Claude SDK surfaces a 429
 * (`rate_limit_error` or `usage_limit_exceeded`) against an OAuth token so
 * Delegate can mark the corresponding `LLMProvider` row with
 * `cooldown_until = now() + COOLDOWN_HOURS` and increment `cooldown_count`.
 * The next picker resolution will skip cooling rows automatically via the
 * `WHERE (cooldown_until IS NULL OR cooldown_until <= now())` filter.
 *
 * Mints a per-workspace JWT (falls back to legacy DELEGATE_AGENT_TOKEN on
 * any mint failure — never throws on mint error).
 *
 * @param opts.providerId        - LLMProvider row id (from `ResolvedLLMKeys.providerId`).
 * @param opts.workspaceId       - Workspace that owns the provider row.
 * @param opts.reason            - Reason code for the cooldown.
 * @param opts.anthropicErrorCode - Optional raw Anthropic error code for audit.
 * @returns true if Delegate acknowledged the report, false on any error.
 */
export async function reportLLMCooldown(opts: {
  providerId: string;
  workspaceId: string;
  reason:
    | 'rate_limit_5h'
    | 'rate_limit_unknown'
    | 'usage_limit_exceeded'
    | 'auth_error';
  anthropicErrorCode?: string;
}): Promise<boolean> {
  if (!DELEGATE_AGENT_TOKEN) {
    console.warn(
      '[cooldown-client] DELEGATE_AGENT_TOKEN unset — skipping cooldown report',
    );
    return false;
  }

  // Mint a per-workspace JWT; fall back to legacy bearer on failure.
  let bearer = DELEGATE_AGENT_TOKEN;
  try {
    const minted = await mintAgentJWT({ workspaceId: opts.workspaceId });
    if (minted) bearer = minted.jwt;
  } catch {
    /* fall back to legacy bearer */
  }

  // 3-attempt retry on 5XX/network errors (Vercel cold start, transient
  // DB hiccup). Cooldown cascades (one bad token → N containers POST 429
  // within seconds) are exactly the burst class that benefits most.
  const res = await fetchWithRetry5xx(
    `${DELEGATE_URL}/api/agent/integrations/llm-keys/cooldown`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(opts),
      signal: AbortSignal.timeout(5000),
    },
    { label: 'cooldown-client' },
  );
  if (!res || !res.ok) {
    console.error(
      `[cooldown-client] cooldown report failed for ${opts.providerId} (status=${res?.status ?? 'network'})`,
    );
    return false;
  }
  return true;
}
