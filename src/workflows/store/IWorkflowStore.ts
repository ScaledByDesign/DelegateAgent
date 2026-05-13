/**
 * Phase 1.5 — `IWorkflowStore` interface.
 *
 * The DAG executor (Phase 2+) talks to this interface, not to better-sqlite3
 * directly, so:
 *   - Tests can stub the store with an in-memory map.
 *   - A future replication adapter (Delegate Prisma mirror, Phase 6) can wrap
 *     a real store with fire-and-forget POSTs without the executor noticing.
 *
 * All time fields are ms-since-epoch (`number`). The SQLite store rehydrates
 * `started_at`/`completed_at`/`last_activity_at` as-stored. Callers that need
 * `Date` objects should wrap them at use site — the wire format stays numeric
 * to match Archon's `INTEGER` column convention and the existing DA
 * `messages.timestamp` convention.
 */

import type {
  ApprovalContext,
  NodeState,
  WorkflowRunStatus,
} from '../schemas/index.js';

/** Persisted shape of a workflow run row. Matches `workflow_runs` columns. */
export interface WorkflowRunRow {
  id: string;
  workflow_name: string;
  chat_jid: string | null;
  workspace_id: string | null;
  task_id: string | null;
  task_delegation_id: string | null;
  user_id: string | null;
  user_message: string;
  status: WorkflowRunStatus;
  /** JSON object — may contain `approval: ApprovalContext`, mirror state, etc. */
  metadata: Record<string, unknown>;
  artifacts_dir: string | null;
  started_at: number | null;
  completed_at: number | null;
  last_activity_at: number | null;
  /** Monotonic event id for mirror idempotency (Phase 6). Null until first event. */
  last_event_id: string | null;
}

/** Persisted shape of one node's state inside a run. */
export interface WorkflowRunNodeRow {
  run_id: string;
  node_id: string;
  state: NodeState;
  output: string | null;
  session_id: string | null;
  error: string | null;
  started_at: number | null;
  completed_at: number | null;
}

/** Persisted shape of one event in the JSONL mirror. */
export interface WorkflowEventRow {
  id: string;
  workflow_run_id: string;
  event_type: string;
  node_id: string | null;
  /** JSON object; arbitrary payload. */
  data: Record<string, unknown>;
  created_at: number;
}

/** Input for `createRun`. Pre-populates `pending` status + `started_at`. */
export interface CreateRunInput {
  id: string;
  workflow_name: string;
  user_message: string;
  chat_jid?: string | null;
  workspace_id?: string | null;
  task_id?: string | null;
  task_delegation_id?: string | null;
  user_id?: string | null;
  metadata?: Record<string, unknown>;
  artifacts_dir?: string | null;
}

/** Patch shape for `updateRunStatus`. Caller controls which fields to write. */
export interface UpdateRunStatusInput {
  status: WorkflowRunStatus;
  metadata?: Record<string, unknown>;
  approval?: ApprovalContext | null;
  artifacts_dir?: string | null;
  completed_at?: number | null;
  last_event_id?: string | null;
}

/** Input for `setNodeState`. */
export interface SetNodeStateInput {
  run_id: string;
  node_id: string;
  state: NodeState;
  output?: string | null;
  session_id?: string | null;
  error?: string | null;
}

/** Input for `appendEvent`. */
export interface AppendEventInput {
  id: string;
  workflow_run_id: string;
  event_type: string;
  node_id?: string | null;
  data?: Record<string, unknown>;
}

/**
 * The executor (Phase 2+) consumes ONLY this interface. The SQLite-backed
 * implementation lives in `./sqlite-workflow-store.ts`. A Prisma-backed
 * mirror wrapper (Phase 6) would wrap a real store and forward writes to
 * the platform-side via fire-and-forget POST.
 */
export interface IWorkflowStore {
  // ─── runs ────────────────────────────────────────────────────────────────
  createRun(input: CreateRunInput): WorkflowRunRow;

  getRun(id: string): WorkflowRunRow | null;

  updateRunStatus(id: string, patch: UpdateRunStatusInput): WorkflowRunRow | null;

  listRunsByStatus(status: WorkflowRunStatus, limit?: number): WorkflowRunRow[];

  /**
   * Concurrency cap: count `running` rows for the given `chat_jid` and
   * compare against `cap`. Returns `null` when the cap is reached; otherwise
   * promotes the run with id `pendingId` from `pending` → `running` and
   * returns the updated row.
   *
   * Implementations MUST be atomic (single transaction) — between the count
   * and the promote, no other run for the same jid can take the slot.
   *
   * `chat_jid: null` is treated as a "no-jid" bucket — still bounded by the
   * same cap so an unbounded burst of non-Delegate-channel runs can't starve
   * the executor.
   */
  claimRun(
    pendingId: string,
    chatJid: string | null,
    cap: number,
  ): WorkflowRunRow | null;

  // ─── per-node state ─────────────────────────────────────────────────────
  setNodeState(input: SetNodeStateInput): WorkflowRunNodeRow;

  listNodesForRun(runId: string): WorkflowRunNodeRow[];

  // ─── events ─────────────────────────────────────────────────────────────
  appendEvent(input: AppendEventInput): WorkflowEventRow;

  listEventsForRun(runId: string, limit?: number): WorkflowEventRow[];
}
