// Phase 2 — workflow event emitter.
//
// Emits structured lifecycle events to two sinks:
//   1. SQLite `workflow_events` table via IWorkflowStore.appendEvent
//   2. (optional) a JSONL file at `<artifacts_dir>/events.jsonl` so the
//      workflow run is inspectable from the filesystem without DB access
//
// Event naming follows the convention from Phase 1 (Pino structured logging):
//   {domain}.{action}_{state}   e.g. workflow.run_started, dag.node_completed
//
// All emits go through `emit(...)` which never throws — sink failures log
// + drop. The executor must NOT abort on a logging-layer failure.

import { randomUUID } from 'crypto';
import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

import { logger } from '../../logger.js';
import type { IWorkflowStore } from '../store/IWorkflowStore.js';
import {
  isLifecycleEventType,
  isMirrorEnabled,
  mirrorWorkflowRunState,
  type MirrorPayloadExtra,
} from '../mirror/workflow-mirror.js';
import {
  isStageHandoffEnabled,
  notifyDelegationTerminal,
  stageHandoffStatusForEvent,
} from '../stage-handoff/notify-terminal.js';

export type WorkflowEventType =
  | 'workflow.run_started'
  | 'workflow.run_completed'
  | 'workflow.run_failed'
  | 'workflow.run_cancelled'
  | 'workflow.run_paused'
  | 'workflow.run_resumed'
  | 'dag.layer_started'
  | 'dag.layer_completed'
  | 'dag.node_started'
  | 'dag.node_completed'
  | 'dag.node_failed'
  | 'dag.node_skipped'
  | 'dag.bash_started'
  | 'dag.bash_completed'
  | 'dag.bash_failed'
  | 'dag.script_started'
  | 'dag.script_completed'
  | 'dag.script_failed'
  | 'dag.prompt_started'
  | 'dag.prompt_completed'
  | 'dag.prompt_failed'
  | 'dag.approval_paused'
  | 'dag.approval_approved'
  | 'dag.approval_rejected'
  | 'dag.loop_iteration_started'
  | 'dag.loop_iteration_completed'
  | 'dag.cancel_triggered';

export interface EmitInput {
  workflowRunId: string;
  type: WorkflowEventType;
  nodeId?: string | null;
  data?: Record<string, unknown>;
}

export interface WorkflowEventEmitter {
  emit(input: EmitInput): void;
  /** Set the artifacts-dir target so JSONL writes resolve to the right path. */
  setArtifactsDir(runId: string, dir: string): void;
  /** Flush + dispose state for a run (called when the run reaches a terminal state). */
  closeRun(runId: string): void;
}

/** Construct the default emitter bound to an IWorkflowStore. */
export function createWorkflowEventEmitter(
  store: IWorkflowStore,
): WorkflowEventEmitter {
  const artifactsDirByRun = new Map<string, string>();

  function emit(input: EmitInput): void {
    const id = randomUUID();
    const now = Date.now();
    const data = input.data ?? {};

    // Sink 1 — SQLite. NEVER throw from the emitter.
    try {
      store.appendEvent({
        id,
        workflow_run_id: input.workflowRunId,
        event_type: input.type,
        node_id: input.nodeId ?? null,
        data,
      });
    } catch (err) {
      logger.error(
        { err, runId: input.workflowRunId, type: input.type },
        'workflow.event_sqlite_emit_failed',
      );
    }

    // Sink 2 — JSONL. Only when an artifacts dir is registered for this run.
    const dir = artifactsDirByRun.get(input.workflowRunId);
    if (dir) {
      const line =
        JSON.stringify({
          id,
          workflow_run_id: input.workflowRunId,
          event_type: input.type,
          node_id: input.nodeId ?? null,
          data,
          created_at: now,
        }) + '\n';
      try {
        const target = join(dir, 'events.jsonl');
        mkdirSync(dirname(target), { recursive: true });
        appendFileSync(target, line, 'utf-8');
      } catch (err) {
        logger.error(
          { err, runId: input.workflowRunId, type: input.type, dir },
          'workflow.event_jsonl_emit_failed',
        );
      }
    }

    // Sink 3 — structured logger so events surface in journalctl + Sentry breadcrumbs.
    logger.info(
      {
        runId: input.workflowRunId,
        type: input.type,
        nodeId: input.nodeId ?? null,
        data,
      },
      input.type,
    );

    // Sink 4 — Phase 6c mirror POST to Delegate platform. Fire-and-forget.
    // Only fires on lifecycle events (run_*); per-node events are noisy and
    // the Prisma mirror only tracks the run row, not events.
    if (isMirrorEnabled() && isLifecycleEventType(input.type)) {
      const extra: MirrorPayloadExtra = {};
      // Surface the channel-renderer fields from event data so the
      // server's LiveEvent emit doesn't need a separate GET.
      if (typeof data.message === 'string') extra.message = data.message;
      if (
        data.approval_type === 'approval' ||
        data.approval_type === 'interactive_loop'
      ) {
        extra.approvalType = data.approval_type;
      }
      if (input.nodeId) extra.nodeId = input.nodeId;
      if (typeof data.iteration === 'number' || data.iteration === null) {
        extra.iteration = data.iteration as number | null;
      }
      if (Array.isArray(data.failed_nodes)) {
        extra.failedNodes =
          (data.failed_nodes as readonly string[]) ?? undefined;
      }
      // Never block, never throw.
      void mirrorWorkflowRunState(input.workflowRunId, { store }, extra).catch(
        (err) => {
          logger.warn(
            {
              err: err instanceof Error ? err.message : String(err),
              runId: input.workflowRunId,
            },
            'workflow.mirror.unexpected_throw',
          );
        },
      );
    }

    // Sink 5 — Phase 6d stage-handoff handshake. POSTs `metadata.terminal:true`
    // to /api/agent/channel/reply when a workflow run reaches completed/failed
    // AND has a task_delegation_id + delegate:task:<id> chat_jid. The platform's
    // reply route transitions the TaskDelegation through the state machine,
    // which fires `task/stage.advance` Inngest event — preserving the
    // single-writer rule for TaskDelegation.status and TaskStageTransition.
    if (isStageHandoffEnabled()) {
      const terminal = stageHandoffStatusForEvent(input.type);
      if (terminal !== null) {
        void notifyDelegationTerminal(input.workflowRunId, terminal, {
          store,
        }).catch((err) => {
          logger.warn(
            {
              err: err instanceof Error ? err.message : String(err),
              runId: input.workflowRunId,
            },
            'workflow.stage_handoff.unexpected_throw',
          );
        });
      }
    }
  }

  function setArtifactsDir(runId: string, dir: string): void {
    artifactsDirByRun.set(runId, dir);
  }

  function closeRun(runId: string): void {
    artifactsDirByRun.delete(runId);
  }

  return { emit, setArtifactsDir, closeRun };
}
