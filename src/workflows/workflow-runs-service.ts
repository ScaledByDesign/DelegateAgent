// Phase 5 — Service layer between group-api HTTP routes and the executor.
//
// Responsibilities:
//   - `startRun`: create the `pending` row, claim the slot via the concurrency
//     cap (Phase 1.5 IWorkflowStore.claimRun), spawn the executor async.
//   - `resumeRun`: hydrate the paused run + decision, spawn `resumeWorkflow`
//     async, return immediately so the HTTP caller doesn't block on a long
//     post-resume execution.
//   - `cancelRun`: signal the in-flight AbortController for the run; the
//     executor honors `signal?.aborted` at layer + loop iteration boundaries.
//   - `abandonRun`: terminal-transition the row to `failed{reason:'abandoned'}`
//     for stuck rows that lost their executor (process restart sweep + manual
//     intervention).
//   - `getRunSnapshot`: returns `{run, nodes, events}` for `GET /runs/:id`,
//     filtering out internal `metadata.loop_state` per Architect Phase 5
//     guidance.
//
// AbortController registry: in-memory `Map<runId, AbortController>` is fine
// because the executor runs in-process. `start`/`resume` create the entry on
// dispatch and remove it when the executor promise settles (in finally).
// Cancel during the gap between row creation and registry entry is a noop —
// the row is still `pending`; the concurrency scanner will pick it up next
// tick and the AbortController will then exist. To handle "cancel a pending
// row before scan", we also flip `workflow_runs.status='cancelled'` directly
// so the scanner skips it.

import { randomUUID } from 'crypto';
import { join } from 'path';
import { mkdirSync } from 'fs';

import { logger } from '../logger.js';
import { loadDagWorkflow } from './dag-loader.js';
import {
  executeWorkflow,
  resumeWorkflow,
  type ExecuteWorkflowResult,
} from './executor/dag-executor.js';
import { createWorkflowEventEmitter } from './executor/event-emitter.js';
import type { ResumeDecision } from './executor/approval-gate.js';
import type { IWorkflowStore, WorkflowRunRow } from './store/IWorkflowStore.js';

/** Configurable concurrency cap (Phase 1.5 / 2). Read on every claim attempt;
 *  Phase 6 will source it from PlatformSetting. v1 default: 4 per chat_jid. */
const DEFAULT_CAP_PER_JID = 4;

/** Default artifacts root. Each run gets a subdirectory under this.
 *  Read lazily (not at module load) so tests can set the env var in
 *  `beforeAll` before instantiating the service. */
function getDefaultArtifactsRoot(): string {
  return (
    process.env.WORKFLOW_ARTIFACTS_DIR ??
    '/var/lib/delegate-agent/workflow-runs'
  );
}

export interface StartRunInput {
  workflowName: string;
  userMessage: string;
  chatJid?: string | null;
  workspaceId?: string | null;
  taskId?: string | null;
  taskDelegationId?: string | null;
  userId?: string | null;
  /** Optional artifacts dir override; if omitted, uses
   *  `<DEFAULT_ARTIFACTS_ROOT>/<runId>`. */
  artifactsDir?: string;
  /** Optional cap override (tests). Defaults to `DEFAULT_CAP_PER_JID`. */
  cap?: number;
}

export interface StartRunResult {
  workflowRunId: string;
  status: WorkflowRunRow['status'];
  /** True when the cap was reached and the run is queued in `pending`. The
   *  concurrency scanner will pick it up on a subsequent tick. */
  queued: boolean;
}

export interface RunSnapshot {
  run: Omit<WorkflowRunRow, 'metadata'> & {
    /** `loop_state` is stripped from the public view — it's internal executor
     *  state, not user-facing. `approval` IS surfaced because the user needs
     *  to render the approval prompt. */
    metadata: Record<string, unknown>;
  };
  nodes: Array<{
    nodeId: string;
    state: string;
    output: string | null;
    error: string | null;
    startedAt: number | null;
    completedAt: number | null;
  }>;
  events: Array<{
    id: string;
    eventType: string;
    nodeId: string | null;
    data: Record<string, unknown>;
    createdAt: number;
  }>;
}

export class WorkflowRunsService {
  /** Running runs keyed by id, so /cancel can abort the in-flight executor. */
  private readonly aborters = new Map<string, AbortController>();

  constructor(private readonly store: IWorkflowStore) {}

  /**
   * Start a new workflow run. Creates the row in `pending`, attempts to claim
   * the concurrency slot, and (on claim success) dispatches the executor
   * asynchronously. Returns immediately so the HTTP caller doesn't block.
   *
   * `queued: true` means the cap is reached — the row is still `pending`.
   * The concurrency scanner (or a subsequent `/runs/:id/resume`) will pick
   * it up; the caller can poll `GET /runs/:id` until status transitions.
   */
  startRun(input: StartRunInput): StartRunResult {
    const id = `wfr-${randomUUID()}`;
    const artifactsDir =
      input.artifactsDir ?? join(getDefaultArtifactsRoot(), id);

    // Ensure the dir exists so bash/script nodes can `cd` into it and write
    // files. mkdirSync with recursive is idempotent.
    try {
      mkdirSync(artifactsDir, { recursive: true });
    } catch (err) {
      logger.warn(
        { err, artifactsDir },
        'workflow_runs_artifacts_mkdir_failed',
      );
    }

    const workflow = loadDagWorkflow(input.workflowName);
    if (!workflow) {
      throw new WorkflowRunsServiceError(
        404,
        `workflow '${input.workflowName}' not found`,
      );
    }

    this.store.createRun({
      id,
      workflow_name: input.workflowName,
      user_message: input.userMessage,
      chat_jid: input.chatJid ?? null,
      workspace_id: input.workspaceId ?? null,
      task_id: input.taskId ?? null,
      task_delegation_id: input.taskDelegationId ?? null,
      user_id: input.userId ?? null,
      artifacts_dir: artifactsDir,
    });

    const claimed = this.store.claimRun(
      id,
      input.chatJid ?? null,
      input.cap ?? DEFAULT_CAP_PER_JID,
    );
    if (!claimed) {
      // Cap reached. Leave the row pending — concurrency scanner picks it up.
      return { workflowRunId: id, status: 'pending', queued: true };
    }

    this.dispatchExecuteAsync(id, workflow.workflow);
    return { workflowRunId: id, status: 'running', queued: false };
  }

  /**
   * Resume a paused run. Validates status='paused', spawns the executor
   * async, returns immediately.
   */
  resumeRun(runId: string, decision: ResumeDecision): { status: string } {
    const run = this.store.getRun(runId);
    if (!run) throw new WorkflowRunsServiceError(404, `run ${runId} not found`);
    if (run.status !== 'paused') {
      throw new WorkflowRunsServiceError(
        409,
        `run ${runId} is not paused (status=${run.status})`,
      );
    }
    const workflow = loadDagWorkflow(run.workflow_name);
    if (!workflow) {
      throw new WorkflowRunsServiceError(
        404,
        `workflow '${run.workflow_name}' not found`,
      );
    }

    this.dispatchResumeAsync(runId, workflow.workflow, decision);
    return { status: 'running' };
  }

  /**
   * Cancel a run. If it's `running`, signals the AbortController so the
   * executor honors the cancel at its next yield boundary. If it's `pending`,
   * flips the row to `cancelled` directly so the concurrency scanner skips
   * it. Idempotent — re-cancelling a terminal run is a no-op.
   */
  cancelRun(runId: string): { status: string } {
    const run = this.store.getRun(runId);
    if (!run) throw new WorkflowRunsServiceError(404, `run ${runId} not found`);
    if (
      run.status === 'completed' ||
      run.status === 'failed' ||
      run.status === 'cancelled'
    ) {
      return { status: run.status };
    }
    if (run.status === 'pending') {
      // Direct terminal flip — no executor in flight to abort.
      this.store.updateRunStatus(runId, {
        status: 'cancelled',
        metadata: { cancel_reason: 'cancelled_while_pending' },
      });
      return { status: 'cancelled' };
    }
    if (run.status === 'paused') {
      // Paused runs have no executor in flight; flip directly to cancelled.
      this.store.updateRunStatus(runId, {
        status: 'cancelled',
        approval: null,
        metadata: { cancel_reason: 'cancelled_while_paused' },
      });
      return { status: 'cancelled' };
    }
    // status === 'running' — signal the AbortController. The executor
    // transitions the run to `cancelled` at the next layer boundary.
    const ac = this.aborters.get(runId);
    if (ac) ac.abort();
    return { status: 'cancelling' };
  }

  /**
   * Abandon a stuck run. Moves status directly to `failed` with reason
   * 'abandoned'. Useful for runs whose executor is gone (orphaned by a
   * crash but somehow missed the startup sweep). Idempotent.
   */
  abandonRun(runId: string): { status: string } {
    const run = this.store.getRun(runId);
    if (!run) throw new WorkflowRunsServiceError(404, `run ${runId} not found`);
    if (
      run.status === 'completed' ||
      run.status === 'failed' ||
      run.status === 'cancelled'
    ) {
      return { status: run.status };
    }
    this.store.updateRunStatus(runId, {
      status: 'failed',
      approval: null,
      metadata: { abandon_reason: 'abandoned_via_api' },
    });
    // If an executor IS in flight, abort it too — abandonment shouldn't leave
    // a running executor consuming budget.
    const ac = this.aborters.get(runId);
    if (ac) ac.abort();
    return { status: 'failed' };
  }

  /**
   * GET /api/workflows/runs/:id response shape. Filters internal
   * `metadata.loop_state` so the loop's per-iteration internals don't leak
   * to channel renderers. Other metadata keys (`approval`, `failed_nodes`,
   * `rejection_reason`, etc.) are preserved.
   */
  getRunSnapshot(runId: string, eventLimit = 50): RunSnapshot | null {
    const run = this.store.getRun(runId);
    if (!run) return null;
    const { loop_state: _internal, ...publicMetadata } = run.metadata as Record<
      string,
      unknown
    >;
    void _internal;
    const nodes = this.store.listNodesForRun(runId).map((n) => ({
      nodeId: n.node_id,
      state: n.state,
      output: n.output,
      error: n.error,
      startedAt: n.started_at,
      completedAt: n.completed_at,
    }));
    const events = this.store.listEventsForRun(runId, eventLimit).map((e) => ({
      id: e.id,
      eventType: e.event_type,
      nodeId: e.node_id,
      data: e.data,
      createdAt: e.created_at,
    }));
    return {
      run: { ...run, metadata: publicMetadata },
      nodes,
      events,
    };
  }

  // ─── internal: async dispatch ──────────────────────────────────────────

  private dispatchExecuteAsync(
    runId: string,
    workflow: NonNullable<ReturnType<typeof loadDagWorkflow>>['workflow'],
  ): void {
    const ac = new AbortController();
    this.aborters.set(runId, ac);
    const emitter = createWorkflowEventEmitter(this.store);
    queueMicrotask(() => {
      executeWorkflow(runId, workflow, {
        store: this.store,
        emitter,
        signal: ac.signal,
      })
        .catch((err) => this.logExecutorCrash(runId, err))
        .finally(() => {
          this.aborters.delete(runId);
        });
    });
  }

  private dispatchResumeAsync(
    runId: string,
    workflow: NonNullable<ReturnType<typeof loadDagWorkflow>>['workflow'],
    decision: ResumeDecision,
  ): void {
    const ac = new AbortController();
    this.aborters.set(runId, ac);
    const emitter = createWorkflowEventEmitter(this.store);
    queueMicrotask(() => {
      resumeWorkflow(
        runId,
        workflow,
        {
          store: this.store,
          emitter,
          signal: ac.signal,
        },
        decision,
      )
        .catch((err) => this.logExecutorCrash(runId, err))
        .finally(() => {
          this.aborters.delete(runId);
        });
    });
  }

  private logExecutorCrash(runId: string, err: unknown): void {
    logger.error({ err, runId }, 'workflow_executor_crashed');
    // Defensive: if the executor crashed BEFORE transitioning the run, the
    // row is stuck in `running`. Flip to failed so subsequent restarts'
    // sweep behavior is consistent.
    try {
      const run = this.store.getRun(runId);
      if (run && run.status === 'running') {
        this.store.updateRunStatus(runId, {
          status: 'failed',
          metadata: {
            crash_reason: err instanceof Error ? err.message : String(err),
          },
        });
      }
    } catch (e) {
      logger.error(
        { err: e, runId },
        'workflow_executor_crash_recovery_failed',
      );
    }
  }

  /** @internal — for tests. Returns the count of in-flight aborters. */
  _inFlightCount(): number {
    return this.aborters.size;
  }

  /** @internal — for tests. Force-await the in-flight microtasks. Tests can
   *  call this to ensure the executor settled before assertions. */
  async _drain(): Promise<void> {
    // Drain microtasks repeatedly until in-flight is zero. Yielding via
    // setImmediate matches the executor's per-layer yield.
    for (let i = 0; i < 200; i++) {
      if (this.aborters.size === 0) return;
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  /** @internal — for tests. Returns whether a given runId has an active aborter. */
  _hasAborter(runId: string): boolean {
    return this.aborters.has(runId);
  }
}

/** Thrown by the service so HTTP handlers can map .status → HTTP code. */
export class WorkflowRunsServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowRunsServiceError';
  }
}
