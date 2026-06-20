// ─── Phase 6d — DA → DP terminal-signal handshake for stage handoff ───
//
// When a workflow run reaches a terminal lifecycle state (completed or
// failed) AND has both `task_delegation_id` AND a `delegate:task:<id>` JID,
// emit a terminal-signal handshake to the platform via
// `POST /api/agent/channel/reply` with:
//   { jid, metadata: { terminal: true, agentStatus: 'success' | 'error' } }
//
// The platform's reply route picks this up and transitions the TaskDelegation
// through `transitionDelegationStatus` (single-writer for TaskDelegation.status).
// That transition fires `task/stage.advance` via the existing Inngest stage-advance
// handler, which is the SOLE writer of `TaskStageTransition` and the sole
// spawner of the next-stage `TaskDelegation`.
//
// Invariants:
//   - We do NOT mutate WorkflowRun (DA SQLite is canonical for that row).
//   - We do NOT write TaskDelegation.status (the platform-side state machine does).
//   - We do NOT write TaskStageTransition (the Inngest handler does).
//   - We do NOT directly fire `task/stage.advance`.
//
// Gating:
//   - boot-time env: `ARCHON_WORKFLOW_STAGE_HANDOFF_ENABLED=1` (off by default)
//   - row must have non-null `task_delegation_id`
//   - row must have non-null `chat_jid` starting with `delegate:task:`
//   - terminal status must be `completed` or `failed`
//   - `DELEGATE_AGENT_TOKEN` must be configured
//
// Failure semantics: NEVER throws. Returns false on non-2xx / network error.
// The executor MUST NOT await this — the value is for tests.

import { logger } from '../../logger.js';
import { getEnvWithFallback } from '../../config.js';
import { mintAgentJWT } from '../../jwt-mint.js';
import type { IWorkflowStore } from '../store/IWorkflowStore.js';

export interface NotifyDeps {
  fetch: typeof fetch;
}

export interface NotifyOptions {
  store: IWorkflowStore;
  deps?: Partial<NotifyDeps>;
}

// ─── Enable flag ────────────────────────────────────────────────────────────

let _enabledCache: boolean | null = null;

export function isStageHandoffEnabled(): boolean {
  if (_enabledCache !== null) return _enabledCache;
  const raw = process.env.ARCHON_WORKFLOW_STAGE_HANDOFF_ENABLED ?? '';
  _enabledCache = raw === '1' || raw.toLowerCase() === 'true';
  return _enabledCache;
}

export function _resetStageHandoffEnabledCache(): void {
  _enabledCache = null;
}

// ─── Terminal status → agentStatus mapping ──────────────────────────────────

type WorkflowTerminal = 'completed' | 'failed';

/** Translate workflow run terminal → platform agentStatus. */
export function terminalToAgentStatus(
  status: WorkflowTerminal,
): 'success' | 'error' {
  return status === 'completed' ? 'success' : 'error';
}

// ─── Notify ─────────────────────────────────────────────────────────────────

const POST_TIMEOUT_MS = 10_000;

/**
 * Emit the platform-side terminal-signal handshake. Returns true on a clean
 * skip or successful POST; false only on network/HTTP error. NEVER throws.
 */
export async function notifyDelegationTerminal(
  runId: string,
  status: WorkflowTerminal,
  opts: NotifyOptions,
): Promise<boolean> {
  if (!isStageHandoffEnabled()) return true;

  const row = opts.store.getRun(runId);
  if (!row) {
    logger.debug({ runId }, 'workflow.stage_handoff.run_not_found');
    return true;
  }
  if (!row.task_delegation_id) {
    logger.debug({ runId }, 'workflow.stage_handoff.skipped_no_delegation');
    return true;
  }
  if (!row.chat_jid || !row.chat_jid.startsWith('delegate:task:')) {
    logger.debug(
      { runId, chatJid: row.chat_jid },
      'workflow.stage_handoff.skipped_not_delegate_task_jid',
    );
    return true;
  }
  // Defensive: only completed / failed feed the handshake. Cancelled and
  // paused MUST NOT advance the stage.
  if (status !== 'completed' && status !== 'failed') {
    logger.debug(
      { runId, status },
      'workflow.stage_handoff.skipped_non_terminal',
    );
    return true;
  }

  const token = getEnvWithFallback('DELEGATE_AGENT_TOKEN', [
    'DELEGATE_API_KEY',
  ]);
  if (!token) {
    logger.debug({ runId }, 'workflow.stage_handoff.no_token');
    return true;
  }

  // JWT migration: mint a per-workspace JWT when workspace_id is available;
  // fall back to legacy bearer on any mint failure.
  let bearer = token;
  if (row.workspace_id) {
    try {
      const minted = await mintAgentJWT({ workspaceId: row.workspace_id });
      if (minted) bearer = minted.jwt;
    } catch {
      /* fall back to legacy bearer */
    }
  }

  const baseUrl = process.env.DELEGATE_URL || 'https://delegate.ws';
  const url = `${baseUrl.replace(/\/$/, '')}/api/agent/channel/reply`;

  const agentStatus = terminalToAgentStatus(status);
  // The reply route's terminal-signal branch reads:
  //   jid.startsWith("delegate:task:") &&
  //   metadata.terminal === true &&
  //   metadata.agentStatus === "success" | "error"
  // Text is intentionally omitted — user-visible content was delivered by
  // previous channel replies (or by the workflow run's own progress events).
  const body = JSON.stringify({
    jid: row.chat_jid,
    metadata: {
      source: 'delegate-agent-workflow',
      terminal: true,
      agentStatus,
      workflowRunId: row.id,
      workflowName: row.workflow_name,
      taskDelegationId: row.task_delegation_id,
    },
  });

  const fetchFn: typeof fetch = opts.deps?.fetch ?? globalThis.fetch;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bearer}`,
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // 404 = old receiver without the terminal-signal branch — tolerate
      // gracefully so a partial-deploy droplet doesn't surface as an error.
      if (res.status === 404) {
        logger.debug(
          { runId, status: 404 },
          'workflow.stage_handoff.receiver_old_format',
        );
        return true;
      }
      const preview = await res.text().catch(() => '');
      logger.warn(
        {
          runId,
          status: res.status,
          preview: preview.slice(0, 200),
        },
        'workflow.stage_handoff.non_2xx',
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), runId },
      'workflow.stage_handoff.post_failed',
    );
    return false;
  }
}

// ─── Event-type filter ──────────────────────────────────────────────────────

const STAGE_HANDOFF_EVENT_TYPES = new Map<string, WorkflowTerminal>([
  ['workflow.run_completed', 'completed'],
  ['workflow.run_failed', 'failed'],
]);

/**
 * Returns the workflow terminal status if `eventType` triggers a
 * stage-handoff handshake, otherwise null. `paused`/`cancelled`/`resumed`/
 * `started` do NOT trigger — stage advancement requires a real terminal.
 */
export function stageHandoffStatusForEvent(
  eventType: string,
): WorkflowTerminal | null {
  return STAGE_HANDOFF_EVENT_TYPES.get(eventType) ?? null;
}
