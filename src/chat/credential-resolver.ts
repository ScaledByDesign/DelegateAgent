// ─── Chat fast-path credential resolver ───
//
// Phase 2 of `.omc/plans/agent-path-credential-failover.md`. Wraps
// `resolveLLMKeysFromDelegate` (container path's credential entry point) and
// translates the discriminated `ResolvedLLMKeys` union into a transport-level
// `TransportSpec` the chat fast-path can dispatch on with a single exhaustive
// switch. Four variants:
//
//   - `api_key`            → custom workspace URL OR system Bifrost with
//                            workspace-owned VK / direct Anthropic key.
//   - `bifrost-env`        → legacy env fallback (no workspaceId / no agent
//                            token / null resolver).
//   - `skip-to-container`  → workspace resolves to OAuth mode — fast-path
//                            defers entirely to the container path which
//                            handles OAuth correctly via Claude SDK.
//                            (Architect Q1 verdict.)
//   - `exhausted`          → workspace OAuth pool exhausted — fast-path
//                            hard-fails, NO Bifrost fallback (AC-OAUTH-
//                            HARD-FAIL-NO-BIFROST analogue).
//
// Caching: 30s TTL for the three "success" variants; 5s TTL for `exhausted`
// to keep the stale-exhausted window short. Null resolver results are NOT
// cached (transient Delegate outage should be retried on next call). Cache
// keyed by `${workspaceId}::${userId ?? ''}` so a per-user override doesn't
// poison the workspace-default entry.

import { resolveLLMKeysFromDelegate } from '../credential-client.js';

const BIFROST_URL = (
  process.env.BIFROST_URL || 'http://localhost:4000'
).replace(/\/$/, '');

function envBifrostVk(): string {
  return process.env.BIFROST_VK || process.env.ANTHROPIC_API_KEY || '';
}

function envAgentToken(): string {
  return (
    process.env.DELEGATE_AGENT_TOKEN ||
    process.env.DELEGATE_API_KEY ||
    process.env.NANOCLAW_TOKEN ||
    ''
  );
}

const SUCCESS_TTL_MS = 30_000;
const EXHAUSTED_TTL_MS = 5_000;

/**
 * Transport specification for the chat fast-path. The four variants are
 * mutually exclusive and the `chatComplete` switch uses a TypeScript `never`
 * exhaustiveness check to catch future drift.
 */
export type TransportSpec =
  | {
      kind: 'api_key';
      url: string;
      headers: Record<string, string>;
      providerId?: string;
      workspaceId: string;
      pickedScope: 'personal' | 'workspace' | 'system';
    }
  | {
      kind: 'bifrost-env';
      url: string;
      headers: Record<string, string>;
    }
  | {
      kind: 'skip-to-container';
      workspaceId: string;
      reason: 'oauth-mode-container-only';
    }
  | { kind: 'exhausted'; workspaceId: string };

/**
 * Thrown when the resolver returns `kind='exhausted'`. Dispatch catches this
 * and surfaces a user-visible "credits exhausted" message. The thrown error
 * MUST NOT trigger a fall-through to the container path — container would
 * call the same resolver and get the same answer (per Architect Q2).
 */
export class CredentialsExhaustedError extends Error {
  constructor(public workspaceId: string) {
    super(
      `Workspace ${workspaceId} has all LLM credentials in cooldown — chat fast-path cannot proceed`,
    );
    this.name = 'CredentialsExhaustedError';
  }
}

/**
 * Thrown when the resolver returns `kind='skip-to-container'`. Dispatch
 * catches this and returns `reason='oauth-mode-container-only'` so the
 * channel falls through to the container path, which handles OAuth via the
 * Claude SDK (`CLAUDE_CODE_OAUTH_TOKEN`). Fast-path NEVER hits
 * `api.anthropic.com` directly (Architect Q1 verdict).
 */
export class SkipToContainerError extends Error {
  constructor(
    public workspaceId: string,
    public reason: 'oauth-mode-container-only' = 'oauth-mode-container-only',
  ) {
    super(
      `Workspace ${workspaceId} resolves to OAuth mode — fast-path defers to container path`,
    );
    this.name = 'SkipToContainerError';
  }
}

interface CacheEntry {
  spec: TransportSpec;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Per-workspace bounded warn-log counter for the bifrost-env-but-workspace-supplied misconfig. */
const warnCount = new Map<string, number>();
const WARN_CAP_PER_WORKSPACE = 5;

function cacheKey(
  workspaceId: string,
  userId: string | null | undefined,
): string {
  return `${workspaceId}::${userId ?? ''}`;
}

function buildBifrostEnvSpec(): TransportSpec {
  const vk = envBifrostVk();
  return {
    kind: 'bifrost-env',
    url: `${BIFROST_URL}/anthropic/v1/messages`,
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(vk ? { 'x-bf-vk': vk } : {}),
    },
  };
}

/**
 * Resolve the transport spec for a chat fast-path call.
 *
 * Returns `bifrost-env` immediately (no resolver call) when:
 *   - `opts.workspaceId` is missing/empty (legacy / dev / self-hosted), OR
 *   - `DELEGATE_AGENT_TOKEN` env is unset (can't auth to Delegate).
 *
 * Otherwise calls `resolveLLMKeysFromDelegate(workspaceId, userId)` and maps:
 *   - null result               → `bifrost-env` (NOT cached — transient outage)
 *   - mode='oauth' + token=null → `exhausted` (cached 5s)
 *   - mode='oauth' + token=X    → `skip-to-container` (cached 30s)
 *   - mode='api_key' w/ baseUrl → `api_key` custom URL + x-api-key  (cached 30s)
 *   - mode='api_key' bare       → `api_key` system Bifrost + x-bf-vk (cached 30s)
 *
 * Cache keyed by `${workspaceId}::${userId ?? ''}` so per-user overrides
 * don't poison the workspace-default entry.
 */
export async function resolveChatTransport(opts: {
  workspaceId?: string | null;
  userId?: string | null;
}): Promise<TransportSpec> {
  const ws = opts.workspaceId ?? null;
  const uid = opts.userId ?? null;

  if (!ws) {
    return buildBifrostEnvSpec();
  }
  if (!envAgentToken()) {
    // Workspace was supplied but the gateway has no Delegate bearer token —
    // we can't call the resolver. Warn (once per workspace, bounded at 5)
    // since this is almost always a misconfig in production.
    const n = warnCount.get(ws) ?? 0;
    if (n < WARN_CAP_PER_WORKSPACE) {
      warnCount.set(ws, n + 1);
      console.warn(
        `[chat-fastpath/credential-resolver] workspaceId=${ws} supplied but DELEGATE_AGENT_TOKEN empty — falling back to bifrost-env (${n + 1}/${WARN_CAP_PER_WORKSPACE})`,
      );
    }
    return buildBifrostEnvSpec();
  }

  const key = cacheKey(ws, uid);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.spec;
  }

  // Mint a per-workspace JWT for this resolution. The credential route
  // (/api/agent/integrations/llm-keys) is JWT-only as of the platform's
  // Phase 7 Sub-step 7.7b cutover; the legacy shared bearer is hard-rejected
  // with 401. mintAgentJWT returns null on any error, in which case
  // resolveLLMKeysFromDelegate falls back to the legacy bearer internally
  // (which only succeeds while the platform's escape-hatch window is open).
  let fastPathJwt: string | null = null;
  try {
    const { mintAgentJWT } = await import('../jwt-mint.js');
    const minted = await mintAgentJWT({ workspaceId: ws });
    if (minted) fastPathJwt = minted.jwt;
  } catch {
    /* fall back to legacy bearer inside resolveLLMKeysFromDelegate */
  }

  const resolved = await resolveLLMKeysFromDelegate(ws, uid, fastPathJwt);

  if (!resolved) {
    // Don't cache null results — could be a transient Delegate outage. We
    // want the next call to retry the resolver rather than hammer
    // bifrost-env for the full 30s window.
    return buildBifrostEnvSpec();
  }

  let spec: TransportSpec;
  let ttl = SUCCESS_TTL_MS;

  if (resolved.mode === 'oauth') {
    if (resolved.oauthToken === null) {
      // pickedScope='exhausted' branch — pool fully cooled.
      spec = { kind: 'exhausted', workspaceId: ws };
      ttl = EXHAUSTED_TTL_MS;
    } else {
      // OAuth success — fast-path defers to container per Q1.
      spec = {
        kind: 'skip-to-container',
        workspaceId: ws,
        reason: 'oauth-mode-container-only',
      };
    }
  } else {
    // mode === 'api_key'
    if (resolved.anthropicBaseUrl) {
      spec = {
        kind: 'api_key',
        url: `${resolved.anthropicBaseUrl.replace(/\/$/, '')}/v1/messages`,
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': resolved.anthropicKey,
        },
        providerId: resolved.providerId,
        workspaceId: ws,
        pickedScope: resolved.pickedScope,
      };
    } else {
      spec = {
        kind: 'api_key',
        url: `${BIFROST_URL}/anthropic/v1/messages`,
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-bf-vk': resolved.anthropicKey,
        },
        providerId: resolved.providerId,
        workspaceId: ws,
        pickedScope: resolved.pickedScope,
      };
    }
  }

  cache.set(key, { spec, expiresAt: now + ttl });
  return spec;
}

/**
 * Test-only — drops the in-memory cache + warn-count maps so unit tests can
 * exercise cache miss paths deterministically. NOT for production use.
 */
export function _clearCacheForTests(): void {
  cache.clear();
  warnCount.clear();
}
