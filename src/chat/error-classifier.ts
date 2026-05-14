// ─── Chat fast-path error classifier ───
//
// Phase 3 of `.omc/plans/agent-path-credential-failover.md`. Mirrors the
// platform's `Delegate/lib/integrations/llm-providers/fallback.ts:37-130`
// taxonomy so dispatch can route credit/auth errors to a single short-
// circuit path (no container fall-through — container would resolve the
// same exhausted credential). Other 4xx/5xx kinds continue falling through
// to the container path under the legacy `bifrost-error` reason.
//
// The classifier handles two entry shapes:
//   - From a non-2xx fetch response: `classifyChatError({status, body})`.
//   - From a thrown error (network / typed error / generic Error): use
//     `classifyChatErrorFromError(err)` which inspects `err.message` for
//     the same body signatures.

export type ChatErrorKind =
  | 'credit_exhausted' // billing / quota / credit balance exhausted
  | 'auth_invalid' // 401/403, bad key
  | 'rate_limited' // 429 transient
  | 'server_error' // 5xx or overloaded
  | 'timeout' // AbortError / TimeoutError
  | 'unknown';

export interface ClassifiedChatError {
  kind: ChatErrorKind;
  retryable: boolean;
  /** True ONLY for credit_exhausted + auth_invalid — the two kinds that warrant fire-and-forget reportLLMCooldown. */
  shouldReportCooldown: boolean;
  body: string; // truncated to 200 chars
  status?: number;
}

const CREDIT_BODY_SIGNATURES = [
  'insufficient_quota',
  'billing',
  'exceeded your current quota',
  'credit',
  'payment required',
  'account is not active',
  'your credit balance is too low',
  'usage_limit_exceeded',
];

const AUTH_BODY_SIGNATURES = [
  'invalid_api_key',
  'incorrect api key',
  'authentication_error',
  'auth_error',
];

const OVERLOADED_SIGNATURES = ['overloaded'];

function truncate(s: string | undefined, n = 200): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) : s;
}

function bodyMatches(body: string, needles: string[]): boolean {
  const lower = body.toLowerCase();
  return needles.some((n) => lower.includes(n.toLowerCase()));
}

/**
 * Classify a non-2xx HTTP response (or a synthetic shape from a thrown
 * error message that includes the upstream body). Returns the kind + the
 * `shouldReportCooldown` boolean dispatch uses to gate `reportLLMCooldown`.
 *
 * Precedence (matches platform `classifyError`):
 *   1. status 402 → credit_exhausted
 *   2. 4xx body contains credit/quota/billing signatures → credit_exhausted
 *   3. status 401 / 403 → auth_invalid
 *   4. 4xx body contains auth signatures → auth_invalid
 *   5. status 429 → rate_limited
 *   6. status 5xx → server_error
 *   7. body contains "overloaded" → server_error
 *   8. error is AbortError / TimeoutError → timeout
 *   9. otherwise → unknown
 */
export function classifyChatError(opts: {
  status?: number;
  body?: string;
  error?: unknown;
}): ClassifiedChatError {
  const status = opts.status;
  const body = truncate(opts.body ?? '');

  // 1 & 2 — credit_exhausted
  if (status === 402) {
    return {
      kind: 'credit_exhausted',
      retryable: false,
      shouldReportCooldown: true,
      body,
      status,
    };
  }
  // Body-signature match — works for both 4xx responses AND synthesized
  // throws that have lost the original status code.
  const is4xx = status !== undefined && status >= 400 && status < 500;
  const statusUnset = status === undefined;
  if ((is4xx || statusUnset) && bodyMatches(body, CREDIT_BODY_SIGNATURES)) {
    return {
      kind: 'credit_exhausted',
      retryable: false,
      shouldReportCooldown: true,
      body,
      status,
    };
  }

  // 3 & 4 — auth_invalid
  if (status === 401 || status === 403) {
    return {
      kind: 'auth_invalid',
      retryable: false,
      shouldReportCooldown: true,
      body,
      status,
    };
  }
  if ((is4xx || statusUnset) && bodyMatches(body, AUTH_BODY_SIGNATURES)) {
    return {
      kind: 'auth_invalid',
      retryable: false,
      shouldReportCooldown: true,
      body,
      status,
    };
  }

  // 5 — rate_limited
  if (status === 429) {
    return {
      kind: 'rate_limited',
      retryable: true,
      shouldReportCooldown: false,
      body,
      status,
    };
  }

  // 6 & 7 — server_error
  if (status !== undefined && status >= 500 && status < 600) {
    return {
      kind: 'server_error',
      retryable: true,
      shouldReportCooldown: false,
      body,
      status,
    };
  }
  if (bodyMatches(body, OVERLOADED_SIGNATURES)) {
    return {
      kind: 'server_error',
      retryable: true,
      shouldReportCooldown: false,
      body,
      status,
    };
  }

  // 8 — timeout
  if (opts.error) {
    const err = opts.error as { name?: string; message?: string };
    const nm = (err.name ?? '').toLowerCase();
    const msg = (err.message ?? '').toLowerCase();
    if (
      nm === 'aborterror' ||
      nm === 'timeouterror' ||
      msg.includes('aborted') ||
      msg.includes('timeout')
    ) {
      return {
        kind: 'timeout',
        retryable: true,
        shouldReportCooldown: false,
        body,
        status,
      };
    }
  }

  return {
    kind: 'unknown',
    retryable: false,
    shouldReportCooldown: false,
    body,
    status,
  };
}

/**
 * Classify a thrown error (Error or unknown). The fast-path throws
 * upstream-shaped errors like `new Error("Anthropic-direct 402: ...body...")`
 * so we extract the leading `<int>:` prefix as the synthetic status and the
 * remainder as the body. Falls back to body-signature matching when no
 * status prefix is found.
 */
export function classifyChatErrorFromError(err: unknown): ChatErrorKind {
  if (err == null) return 'unknown';
  const message = err instanceof Error ? err.message : String(err);
  const m = message.match(/\b(\d{3})\b\s*[:\-]\s*(.*)$/s);
  if (m) {
    const status = parseInt(m[1], 10);
    const body = m[2] ?? '';
    return classifyChatError({ status, body, error: err }).kind;
  }
  return classifyChatError({ body: message, error: err }).kind;
}
