// ─── Agent JWT Mint Client ───
// Calls the Delegate platform's /api/agent/jwt/issue endpoint to mint
// a short-lived, per-workspace JWT for the container being spawned.
//
// The JWT carries a signed `wid` claim so the server can enforce tenant
// isolation without trusting the request body. The container receives
// both DELEGATE_AGENT_JWT (preferred) and DELEGATE_AGENT_TOKEN (legacy
// fallback) during the Phase 2 migration window.

import { getEnvWithFallback } from './config.js';
import { logger } from './logger.js';

const DELEGATE_URL = process.env.DELEGATE_URL || 'https://delegate.ws';
// Bootstrap bearer — used only to call /api/agent/jwt/issue.
// The minted JWT replaces it for all subsequent container API calls.
const DELEGATE_AGENT_TOKEN =
  getEnvWithFallback('DELEGATE_AGENT_TOKEN', ['DELEGATE_API_KEY']) || '';

export interface MintJWTOptions {
  workspaceId?: string;
  taskId?: string;
  agentProfileId?: string;
  scope?: string[];
  ttlSec?: number;
}

export interface MintedJWT {
  jwt: string;
  jti: string;
  expiresAt: number; // epoch seconds
  scope: string[];
  wid: string;
}

/**
 * Mint a per-workspace agent JWT by calling the Delegate platform.
 *
 * Returns null on any error so callers can fall back to legacy bearer
 * without interrupting container spawn. Errors are logged at warn level.
 *
 * Uses a 10-second AbortController timeout — do not hang the spawn path.
 */
export async function mintAgentJWT(
  opts: MintJWTOptions,
): Promise<MintedJWT | null> {
  if (!DELEGATE_AGENT_TOKEN) {
    logger.warn(
      { workspaceId: opts.workspaceId },
      'Agent JWT mint skipped — DELEGATE_AGENT_TOKEN not set',
    );
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(`${DELEGATE_URL}/api/agent/jwt/issue`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DELEGATE_AGENT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        workspaceId: opts.workspaceId,
        taskId: opts.taskId,
        agentProfileId: opts.agentProfileId,
        scope: opts.scope,
        ttlSec: opts.ttlSec,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      logger.warn(
        { workspaceId: opts.workspaceId, status: res.status },
        'Agent JWT mint failed — non-2xx response',
      );
      return null;
    }

    // Platform wraps with apiSuccess envelope: { success: true, data: { jwt, jti, ... } }
    const body: any = await res.json();
    const data = body?.data;

    if (
      !data ||
      typeof data.jwt !== 'string' ||
      typeof data.jti !== 'string' ||
      typeof data.expiresAt !== 'number' ||
      typeof data.wid !== 'string' ||
      !Array.isArray(data.scope)
    ) {
      logger.warn(
        { workspaceId: opts.workspaceId },
        'Agent JWT mint failed — malformed response envelope',
      );
      return null;
    }

    return {
      jwt: data.jwt,
      jti: data.jti,
      expiresAt: data.expiresAt,
      scope: data.scope as string[],
      wid: data.wid,
    };
  } catch (e) {
    const msg = (e as Error).message;
    if ((e as Error).name === 'AbortError') {
      logger.warn(
        { workspaceId: opts.workspaceId },
        'Agent JWT mint timed out after 10s',
      );
    } else {
      logger.warn(
        { workspaceId: opts.workspaceId, err: msg },
        'Agent JWT mint failed — fetch error',
      );
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
