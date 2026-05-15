// ─── Chat fast-path dispatch ───
//
// Phase 5 of `.omc/plans/agent-path-credential-failover.md`. Consumes
// `inbound.workspaceId` (Phase 0 emit from the platform's poll-handler) as
// the primary workspace identifier; falls back to a one-call
// `resolveWorkspaceForJid` helper for `delegate:task:*` JIDs only (back-compat
// for the brief window before platform Phase 0 is fully deployed; dead code
// thereafter).
//
// chatComplete throws typed errors for OAuth-mode + exhausted-pool
// workspaces; dispatch translates each into a distinct ChatSkipReason so the
// channel knows whether to fall through to the container path (oauth-mode
// or generic bifrost-error) or to surface a user-visible "credits exhausted"
// message (credentials-failure → NO container fall-through, per Architect Q2).

import { chatComplete } from './bifrost-client.js';
import {
  CredentialsExhaustedError,
  SkipToContainerError,
} from './credential-resolver.js';
import { classifyChatErrorFromError } from './error-classifier.js';
import { classifyForFastPath } from './heuristic.js';
import type { ChatDispatchResult, ChatInbound } from './types.js';
import { recordFastpath } from '../metrics.js';

// Marker the Delegate poll-handler emits when wrapping a user message with
// task context (see app/api/agent/channel/poll/poll-handler.ts ~L666). When
// present we extract just the post-marker portion as the actual user
// message and treat the preamble as additional system context.
const USER_MESSAGE_DELIMITER = '\n━━━━━━━━━━━━━━━━━━━━━━━━\nUSER MESSAGE:\n';

const DELEGATE_URL = (
  process.env.DELEGATE_URL || 'https://delegate.ws'
).replace(/\/$/, '');

interface SplitContext {
  userText: string;
  systemPrefix: string | null;
}

function splitWrappedContext(text: string): SplitContext {
  const idx = text.indexOf(USER_MESSAGE_DELIMITER);
  if (idx === -1) {
    return { userText: text, systemPrefix: null };
  }
  return {
    userText: text.slice(idx + USER_MESSAGE_DELIMITER.length).trim(),
    systemPrefix: text.slice(0, idx).trim(),
  };
}

// ─── Sentry breadcrumb + tag helper (optional — Sentry SDK may not be installed) ───

let Sentry: {
  addBreadcrumb?: (b: unknown) => void;
  setTag?: (key: string, value: string | number | boolean) => void;
} | null = null;
try {
  Sentry =
    (globalThis as { __SENTRY__?: typeof Sentry }).__SENTRY__ ||
    require('@sentry/node');
} catch {
  /* @sentry/node not installed — breadcrumbs go to /dev/null */
}

function breadcrumb(message: string, data: Record<string, unknown>): void {
  if (!Sentry?.addBreadcrumb) return;
  try {
    Sentry.addBreadcrumb({
      category: 'chat-fastpath',
      message,
      data,
      level: 'info',
    });
  } catch {
    /* never let Sentry throw */
  }
  // Plan §9 follow-up #4 — set `chatFastpathMode` as a Sentry tag so the
  // Sentry UI can filter/group by mode (api_key / bifrost-env / exhausted /
  // skip-to-container / unknown) without parsing breadcrumb JSON. Tag sticks
  // to the current async scope so any downstream `captureException` within
  // the same dispatch lifecycle inherits it. Internal-only ("Bifrost" terms
  // here are fine per §10.13 invariant I8 — Sentry tags are ops/internal).
  const mode = data?.mode;
  if (typeof mode === 'string' && Sentry?.setTag) {
    try {
      Sentry.setTag('chatFastpathMode', mode);
    } catch {
      /* never let Sentry throw */
    }
  }
}

/**
 * Optional callback for richer chat context — task title/description for the
 * system prompt. The host-side implementation may fetch task title /
 * description / recent message history for a given JID. Returning null falls
 * back to the generic system prompt.
 *
 * Phase 4 of agent-path-credential-failover plan: the oauthToken field on
 * the resolver result is now ignored — credential resolution moved into the
 * per-call TransportSpec resolver in `bifrost-client.ts`. The field stays on
 * the return type for back-compat with the existing registration in
 * `delegate.ts:resolveChatFastpathCreds`; it's read but discarded.
 */
export type ChatContextResolver = (
  jid: string,
) =>
  | Promise<{ system: string; oauthToken?: string | null } | null>
  | { system: string; oauthToken?: string | null }
  | null;

let contextResolver: ChatContextResolver | null = null;

/**
 * Plug in a function the dispatch will call to assemble a system prompt
 * (task title, description, recent message history, agent persona) for a
 * given JID. If no resolver is registered, falls back to a generic prompt.
 */
export function setChatContextResolver(fn: ChatContextResolver | null): void {
  contextResolver = fn;
}

const FALLBACK_SYSTEM_PROMPT = [
  'You are DelegateAgent, the conversational AI assistant for the Delegate workspace.',
  'Reply concisely and conversationally. Do not pretend to execute tools or modify',
  'files — if the user asks for work that needs file edits or commands, ask them to',
  'phrase it as a task and the heavier agent will pick it up.',
].join(' ');

// ─── Task-JID → workspaceId fallback (back-compat for pre-Phase-0 platforms) ──
//
// When `inbound.workspaceId` is absent (legacy emit), this helper round-trips
// to `GET /api/agent/context/[taskId]` to derive the workspace. Only used for
// `delegate:task:*` JIDs — conv/agent/main JIDs return null and the dispatcher
// falls back to `kind='bifrost-env'` in the resolver. Once platform Phase 0
// is fully deployed everywhere, this helper is dead code.

const WORKSPACE_RESOLVE_CACHE_TTL_MS = 60_000;
const workspaceCache = new Map<
  string,
  { workspaceId: string | null; expiresAt: number }
>();

function envAgentToken(): string {
  return (
    process.env.DELEGATE_AGENT_TOKEN ||
    process.env.DELEGATE_API_KEY ||
    process.env.NANOCLAW_TOKEN ||
    ''
  );
}

export async function resolveWorkspaceForJid(
  jid: string,
): Promise<string | null> {
  if (!jid.startsWith('delegate:task:')) return null;
  const token = envAgentToken();
  if (!token) return null;
  const taskId = jid.slice('delegate:task:'.length);
  if (!taskId) return null;

  const now = Date.now();
  const cached = workspaceCache.get(taskId);
  if (cached && cached.expiresAt > now) return cached.workspaceId;

  try {
    const res = await fetch(
      `${DELEGATE_URL}/api/agent/context/${encodeURIComponent(taskId)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) {
      workspaceCache.set(taskId, {
        workspaceId: null,
        expiresAt: now + WORKSPACE_RESOLVE_CACHE_TTL_MS,
      });
      return null;
    }
    const data = (await res.json()) as {
      data?: {
        task?: {
          workspaceId?: string | null;
          project?: { workspaceId?: string | null };
        };
      };
    };
    const t = data?.data?.task ?? {};
    const ws = t.workspaceId ?? t.project?.workspaceId ?? null;
    workspaceCache.set(taskId, {
      workspaceId: ws,
      expiresAt: now + WORKSPACE_RESOLVE_CACHE_TTL_MS,
    });
    return ws;
  } catch (err) {
    console.warn(
      `[chat-fastpath/dispatch] resolveWorkspaceForJid failed for ${jid}: ${(err as Error).message}`,
    );
    return null;
  }
}

/**
 * Test-only — drops the in-memory task→workspace cache.
 */
export function _clearWorkspaceCacheForTests(): void {
  workspaceCache.clear();
}

/**
 * Try to handle an inbound message via the chat fast-path.
 *
 * - `{ handled: true, replyText }` → caller sends replyText, skips container.
 * - `{ handled: false, reason: 'oauth-mode-container-only' | 'bifrost-error' }`
 *   → caller falls through to the container path.
 * - `{ handled: false, reason: 'credentials-failure', userMessage }`
 *   → caller MUST NOT fall through to container (container would resolve the
 *   same exhausted credential). Channel should surface `userMessage` to the
 *   user. Per Architect Q2 verdict.
 */
export async function dispatchChatFastPath(
  inbound: ChatInbound,
): Promise<ChatDispatchResult> {
  // The Delegate poll-handler wraps user messages on task JIDs with a large
  // task-context preamble. Strip it before classifying so a 22-char "hi" isn't
  // judged as a 1500-char prompt; preserve the preamble as the system context.
  const split = splitWrappedContext(inbound.text);
  const userText = split.userText;

  const skip = classifyForFastPath(userText);
  if (skip) {
    recordFastpath(`skip-${skip}`);
    return { handled: false, reason: skip };
  }

  const startedAt = Date.now();
  let system = split.systemPrefix
    ? `${FALLBACK_SYSTEM_PROMPT}\n\n--- TASK CONTEXT ---\n${split.systemPrefix}`
    : FALLBACK_SYSTEM_PROMPT;
  if (contextResolver) {
    try {
      const ctx = await contextResolver(inbound.jid);
      if (ctx?.system) system = ctx.system;
      // ctx.oauthToken intentionally ignored — Phase 4 (Architect Q1)
      // routes OAuth-mode workspaces to the container path; fast-path
      // never carries a per-call OAuth token anymore.
    } catch {
      // Context resolver is best-effort — log via console only, fall back
      // to generic system prompt rather than escalating.
    }
  }

  // Resolve workspace + user for the credential resolver. Prefer the
  // platform-emitted `inbound.workspaceId` (Phase 0); fall back to the
  // context-endpoint round-trip ONLY for task JIDs when missing (back-compat).
  const workspaceId =
    inbound.workspaceId ?? (await resolveWorkspaceForJid(inbound.jid));
  const userId = inbound.requestingUserId ?? null;

  try {
    const reply = await chatComplete({
      system,
      userMessage: userText,
      workspaceId,
      userId,
    });
    const latencyMs = Date.now() - startedAt;
    const outcome =
      reply.transportMode === 'api_key' ? 'hit-api_key' : 'hit-bifrost-env';
    recordFastpath(outcome);
    breadcrumb('chat-fastpath.dispatch', {
      jid: inbound.jid,
      workspaceId,
      mode: reply.transportMode,
      outcome: 'handled',
      latencyMs,
    });
    return {
      handled: true,
      replyText: reply.text,
      latencyMs,
      model: reply.model,
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;

    if (err instanceof SkipToContainerError) {
      recordFastpath('skip-oauth-mode-container-only');
      breadcrumb('chat-fastpath.dispatch', {
        jid: inbound.jid,
        workspaceId,
        mode: 'skip-to-container',
        outcome: 'skipped:oauth-mode-container-only',
        latencyMs,
      });
      return { handled: false, reason: 'oauth-mode-container-only' };
    }

    if (err instanceof CredentialsExhaustedError) {
      recordFastpath('skip-credentials-failure');
      breadcrumb('chat-fastpath.dispatch', {
        jid: inbound.jid,
        workspaceId,
        mode: 'exhausted',
        outcome: 'skipped:credentials-failure',
        latencyMs,
      });
      return {
        handled: false,
        reason: 'credentials-failure',
        userMessage: 'Workspace LLM credits exhausted — contact admin',
      };
    }

    // Classify the thrown upstream error. credit_exhausted / auth_invalid
    // short-circuit to credentials-failure (no container fall-through —
    // container would resolve the same exhausted credential, Architect Q2).
    // Other kinds (rate_limited, server_error, timeout, unknown) keep the
    // legacy bifrost-error path — channel falls through to container.
    const kind = classifyChatErrorFromError(err);
    if (kind === 'credit_exhausted' || kind === 'auth_invalid') {
      recordFastpath('skip-credentials-failure');
      breadcrumb('chat-fastpath.dispatch', {
        jid: inbound.jid,
        workspaceId,
        mode: 'api_key',
        outcome: 'skipped:credentials-failure',
        classification: kind,
        latencyMs,
      });
      return {
        handled: false,
        reason: 'credentials-failure',
        userMessage: 'Workspace LLM credits exhausted — contact admin',
      };
    }

    recordFastpath('skip-bifrost-error');
    breadcrumb('chat-fastpath.dispatch', {
      jid: inbound.jid,
      workspaceId,
      mode: 'unknown',
      outcome: 'skipped:bifrost-error',
      classification: kind,
      latencyMs,
    });
    return { handled: false, reason: 'bifrost-error' };
  }
}
