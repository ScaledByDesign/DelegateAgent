// ─── Delegate Cooldown Reporter ───
// POSTs to /api/agent/integrations/llm-keys/cooldown when the in-container
// Claude SDK returns a 429 (rate_limit_error / usage_limit_exceeded).
// Delegate marks the row's cooldown_until + cooldown_count; next picker
// resolution skips it. Bearer auth via DELEGATE_AGENT_TOKEN (same as
// resolveLLMKeysFromDelegate).

import { getEnvWithFallback } from './config.js';

const DELEGATE_URL = process.env.DELEGATE_URL || 'https://delegate.ws';
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
  try {
    const res = await fetch(
      `${DELEGATE_URL}/api/agent/integrations/llm-keys/cooldown`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DELEGATE_AGENT_TOKEN}`,
        },
        body: JSON.stringify(opts),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) {
      console.error(
        `[cooldown-client] non-ok ${res.status} for ${opts.providerId}`,
      );
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[cooldown-client] fetch failed: ${(e as Error).message}`);
    return false;
  }
}
