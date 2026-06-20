// ─── Shared DelegateAgent → delegate.ws fetch helper ───
//
// Exports `agentFetch(path, { workspaceId, userId?, init })` — a thin wrapper
// over global `fetch` that:
//
//   1. Mints a per-workspace JWT via `mintAgentJWT({workspaceId})` when
//      `workspaceId` is present.
//   2. Sets `Authorization: Bearer <jwt>` when minted successfully.
//   3. Falls back to the legacy `DELEGATE_AGENT_TOKEN` bearer
//      (getEnvWithFallback chain) when:
//       - `workspaceId` is absent/null
//       - minting fails for any reason (error is logged, never thrown)
//   4. Merges `init.headers` so callers can still set Content-Type, etc.
//      Caller-supplied `Authorization` is NEVER clobbered unless we minted a
//      JWT (JWT takes precedence over both legacy bearer and caller header).
//   5. Resolves the base URL via DELEGATE_URL env var (same as all other
//      delegate.ws callers in this repo) — callers pass only the path portion.
//
// The function preserves `init.method`, `init.body`, `init.signal`, and any
// other RequestInit fields unchanged.
//
// This is the single canonical auth-injection point for all outbound
// delegate.ws HTTP calls originating from DelegateAgent host process.
// In-container curl doc-strings (context-files.ts, git-auth.ts) run inside the
// container where DELEGATE_AGENT_JWT is already injected directly — they are
// left as-is (see those files for comments).

import { getEnvWithFallback } from './config.js';
import { logger } from './logger.js';
import { mintAgentJWT } from './jwt-mint.js';

// Base URL shared with all other callers — strip trailing slash once.
const DELEGATE_URL = (
  process.env.DELEGATE_URL || 'https://delegate.ws'
).replace(/\/$/, '');

// Legacy bootstrap bearer — used as fallback when mint fails or workspaceId
// is absent. Matches the getEnvWithFallback chain used in jwt-mint.ts and
// every other delegate.ws caller.
const LEGACY_TOKEN =
  getEnvWithFallback('DELEGATE_AGENT_TOKEN', [
    'DELEGATE_API_KEY',
    'NANOCLAW_TOKEN',
  ]) || '';

/**
 * Options for `agentFetch`.
 */
export interface AgentFetchOptions {
  /**
   * Workspace whose per-workspace JWT should be minted for this request.
   * When absent/null, the call falls back to the legacy DELEGATE_AGENT_TOKEN
   * bearer automatically.
   */
  workspaceId?: string | null;
  /**
   * Optional user id — forwarded to `mintAgentJWT` when workspaceId is
   * present so the minted JWT can carry a `uid` claim.
   */
  userId?: string | null;
  /**
   * Standard RequestInit — method, body, headers, signal, etc.
   * These are passed through unchanged except that `Authorization` is
   * injected (JWT when minted, legacy bearer otherwise).
   * If the caller supplies an `Authorization` header AND we mint a JWT,
   * the minted JWT wins. If we fall back to legacy bearer, a caller-supplied
   * `Authorization` is preserved as-is (legacy bearer is NOT injected when
   * the caller already set the header — avoids double-auth in edge cases).
   */
  init?: RequestInit;
}

/**
 * Thin fetch wrapper that mints a per-workspace JWT for `workspaceId` (when
 * present) and sets `Authorization: Bearer <jwt>`. Falls back to the legacy
 * DELEGATE_AGENT_TOKEN bearer on any mint failure or when `workspaceId` is
 * absent. Never throws due to mint failure.
 *
 * @param path  - URL path including leading slash and any query string,
 *                e.g. `/api/agent/integrations/skills?workspaceId=...`.
 *                The base URL is resolved from DELEGATE_URL env var.
 * @param opts  - workspaceId, optional userId, and standard RequestInit.
 * @returns     - The fetch Response (same as calling global fetch directly).
 */
export async function agentFetch(
  path: string,
  opts: AgentFetchOptions = {},
): Promise<Response> {
  const { workspaceId, userId, init = {} } = opts;

  // ── Determine Authorization bearer ────────────────────────────────────
  let bearer: string | null = null;

  if (workspaceId) {
    try {
      const minted = await mintAgentJWT({
        workspaceId,
        ...(userId ? { scope: [`uid:${userId}`] } : {}),
      });
      if (minted) {
        bearer = minted.jwt;
      } else {
        // mintAgentJWT already logs at warn level; fall through to legacy
        logger.debug(
          { workspaceId },
          'agentFetch: JWT mint returned null — using legacy bearer',
        );
      }
    } catch (err) {
      logger.warn(
        { workspaceId, err: (err as Error).message },
        'agentFetch: JWT mint threw — using legacy bearer',
      );
    }
  }

  // ── Merge headers ──────────────────────────────────────────────────────
  // Caller headers come first so Content-Type / custom headers are preserved.
  // Authorization is layered on top:
  //   - JWT wins over everything (fresh mint for this workspace)
  //   - Legacy bearer wins over caller-supplied auth when caller didn't set it
  //   - If no bearer is available AND caller supplied Authorization, keep caller's
  const callerHeaders = new Headers(init.headers);

  if (bearer) {
    // Minted JWT — always set, overrides any caller-supplied Authorization.
    callerHeaders.set('Authorization', `Bearer ${bearer}`);
  } else if (!callerHeaders.has('Authorization')) {
    // No JWT — inject legacy bearer only when caller hasn't set their own.
    if (LEGACY_TOKEN) {
      callerHeaders.set('Authorization', `Bearer ${LEGACY_TOKEN}`);
    }
    // If LEGACY_TOKEN is also empty, the request goes out without auth
    // (the server will 401; callers handle that the same way they do today).
  }
  // else: caller provided Authorization AND we have no JWT → keep caller's header

  // ── Execute fetch ──────────────────────────────────────────────────────
  const url = `${DELEGATE_URL}${path}`;
  return fetch(url, {
    ...init,
    headers: callerHeaders,
  });
}
