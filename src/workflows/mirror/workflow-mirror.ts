// ─── Phase 6c — DA → DP workflow mirror POST ───
//
// Fire-and-forget POST to `<DELEGATE_URL>/api/agent/workflow/runs` every time
// a workflow run reaches a new lifecycle state. DA SQLite remains the
// authoritative source — the mirror exists for cross-droplet visibility
// (Delegation Board WebOS app, LiveEvents in browser tabs).
//
// Gating: boot-time env flag `ARCHON_WORKFLOW_MIRROR_ENABLED=1`. Read once,
// cached for the process lifetime. Flipping the flag requires a restart;
// that is intentional for the rollout window. The DP-side platform setting
// `archon_workflow_runs_enabled` is informational at this point — the sink
// always accepts; the executor decides whether to post.
//
// Drop conditions (silent, log at debug):
//   - mirror disabled by env
//   - DA row has NULL workspace_id (server's 400 path)
//   - no DELEGATE_AGENT_TOKEN configured
//
// Failure semantics: NEVER throws. Returns `false` on non-2xx / network
// error so the caller can log/breadcrumb. The executor MUST NOT block on
// the resolved value.
//
// Field mapping (DA SQLite row → wire):
//   chat_jid          → agentJid   (server also accepts chat_jid for back-compat)
//   started_at        → startedAtMs
//   completed_at      → completedAtMs
//   last_activity_at  → lastActivityAtMs
//   metadata          → metadata   (server filters loop_state)
//   last_event_id     → lastEventId
//
// Idempotency: server compares `lastEventId` monotonically. Same id → no-op.

import { logger } from '../../logger.js';
import { getEnvWithFallback } from '../../config.js';
import type {
  IWorkflowStore,
  WorkflowRunRow,
} from '../store/IWorkflowStore.js';

export interface MirrorDeps {
  fetch: typeof fetch;
}

export interface MirrorPayloadExtra {
  /** Pause message — surfaced to channel renderers so they don't need a GET. */
  message?: string;
  approvalType?: 'approval' | 'interactive_loop';
  nodeId?: string;
  iteration?: number | null;
  failedNodes?: readonly string[];
}

export interface MirrorOptions {
  store: IWorkflowStore;
  deps?: Partial<MirrorDeps>;
}

// ─── Enable flag ────────────────────────────────────────────────────────────

let _enabledCache: boolean | null = null;

export function isMirrorEnabled(): boolean {
  if (_enabledCache !== null) return _enabledCache;
  const raw = process.env.ARCHON_WORKFLOW_MIRROR_ENABLED ?? '';
  _enabledCache = raw === '1' || raw.toLowerCase() === 'true';
  return _enabledCache;
}

/** Test hook: reset the env cache between tests. */
export function _resetMirrorEnabledCache(): void {
  _enabledCache = null;
}

// ─── Payload mapper ─────────────────────────────────────────────────────────

interface WirePayload {
  workflowRunId: string;
  workspaceId: string;
  workflowName: string;
  status: string;
  userMessage: string;
  taskDelegationId: string | null;
  taskId: string | null;
  agentJid: string | null;
  userId: string | null;
  artifactsDir: string | null;
  metadata: Record<string, unknown>;
  lastEventId: string | null;
  startedAtMs: number | null;
  completedAtMs: number | null;
  lastActivityAtMs: number | null;
  message?: string;
  approvalType?: 'approval' | 'interactive_loop';
  nodeId?: string;
  iteration?: number | null;
  failedNodes?: readonly string[];
}

export function buildMirrorPayload(
  row: WorkflowRunRow,
  extra?: MirrorPayloadExtra,
): WirePayload {
  return {
    workflowRunId: row.id,
    // Caller is responsible for verifying workspace_id !== null before
    // calling buildMirrorPayload — but assert by cast here so the
    // typescript shape matches the server contract.
    workspaceId: row.workspace_id as string,
    workflowName: row.workflow_name,
    status: row.status,
    userMessage: row.user_message,
    taskDelegationId: row.task_delegation_id,
    taskId: row.task_id,
    agentJid: row.chat_jid,
    userId: row.user_id,
    artifactsDir: row.artifacts_dir,
    metadata: row.metadata,
    lastEventId: row.last_event_id,
    startedAtMs: row.started_at,
    completedAtMs: row.completed_at,
    lastActivityAtMs: row.last_activity_at,
    message: extra?.message,
    approvalType: extra?.approvalType,
    nodeId: extra?.nodeId,
    iteration: extra?.iteration,
    failedNodes: extra?.failedNodes,
  };
}

// ─── POST ───────────────────────────────────────────────────────────────────

const POST_TIMEOUT_MS = 10_000;

/**
 * Fire-and-forget mirror POST. Resolves to `true` when the POST landed
 * successfully OR was intentionally skipped (mirror disabled, missing
 * workspace, missing token). Resolves to `false` only when a network error
 * or non-2xx surfaced.
 *
 * The executor MUST NOT await this. Tests await the return value to assert
 * happy-path behavior.
 */
export async function mirrorWorkflowRunState(
  runId: string,
  opts: MirrorOptions,
  extra?: MirrorPayloadExtra,
): Promise<boolean> {
  if (!isMirrorEnabled()) return true;

  const row = opts.store.getRun(runId);
  if (!row) {
    logger.debug({ runId }, 'workflow.mirror.run_not_found');
    return true;
  }
  if (!row.workspace_id) {
    logger.debug({ runId }, 'workflow.mirror.dropped_missing_workspace');
    return true;
  }

  const token = getEnvWithFallback('DELEGATE_AGENT_TOKEN', [
    'DELEGATE_API_KEY',
  ]);
  if (!token) {
    logger.debug({ runId }, 'workflow.mirror.no_token');
    return true;
  }

  const baseUrl = process.env.DELEGATE_URL || 'https://delegate.ws';
  const url = `${baseUrl.replace(/\/$/, '')}/api/agent/workflow/runs`;

  const payload = buildMirrorPayload(row, extra);
  const body = JSON.stringify(payload);

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
          authorization: `Bearer ${token}`,
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const preview = await res.text().catch(() => '');
      logger.warn(
        {
          runId,
          status: res.status,
          preview: preview.slice(0, 200),
        },
        'workflow.mirror.non_2xx',
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        runId,
      },
      'workflow.mirror.post_failed',
    );
    return false;
  }
}

// ─── Event-type filter ──────────────────────────────────────────────────────

/**
 * Workflow lifecycle events that should trigger a mirror POST. Per-node
 * events (dag.node_*, dag.bash_*, etc.) are NOT mirrored — they're too
 * chatty for the cross-droplet sync and the Delegation Board UI consumes
 * run-level state only (via LiveEvents + GET /api/workflow/runs/:id).
 */
const LIFECYCLE_EVENT_TYPES = new Set<string>([
  'workflow.run_started',
  'workflow.run_completed',
  'workflow.run_failed',
  'workflow.run_cancelled',
  'workflow.run_paused',
  'workflow.run_resumed',
]);

export function isLifecycleEventType(eventType: string): boolean {
  return LIFECYCLE_EVENT_TYPES.has(eventType);
}
