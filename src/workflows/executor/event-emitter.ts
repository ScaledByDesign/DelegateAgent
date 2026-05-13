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
  }

  function setArtifactsDir(runId: string, dir: string): void {
    artifactsDirByRun.set(runId, dir);
  }

  function closeRun(runId: string): void {
    artifactsDirByRun.delete(runId);
  }

  return { emit, setArtifactsDir, closeRun };
}
