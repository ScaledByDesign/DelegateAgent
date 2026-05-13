/**
 * Phase 1.5 — `IWorkflowStore` backed by the better-sqlite3 connection
 * created in `db.ts`.
 *
 * Concurrency model:
 *   - `claimRun` uses an explicit transaction: count `running` for `chat_jid`,
 *     then promote `pending` → `running` atomically. Returns null if the cap
 *     is reached so the caller can leave the run in `pending` and the
 *     concurrency scanner (Phase 2) re-checks on the next tick.
 *   - `appendEvent` and `setNodeState` are single statements; SQLite's WAL
 *     mode handles them under the existing single-writer Node.js process.
 *
 * All metadata is JSON-encoded with `JSON.stringify`. The `metadata` column
 * on `workflow_runs` is the catch-all for approval context, mirror state,
 * orphan reason, etc. Callers should treat it as opaque except for the
 * `approval` key (set by `updateRunStatus({ approval })`).
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';

import type {
  ApprovalContext,
  WorkflowRunStatus,
} from '../schemas/index.js';
import type {
  AppendEventInput,
  CreateRunInput,
  IWorkflowStore,
  SetNodeStateInput,
  UpdateRunStatusInput,
  WorkflowEventRow,
  WorkflowRunNodeRow,
  WorkflowRunRow,
} from './IWorkflowStore.js';

interface RawRunRow {
  id: string;
  workflow_name: string;
  chat_jid: string | null;
  workspace_id: string | null;
  task_id: string | null;
  task_delegation_id: string | null;
  user_id: string | null;
  user_message: string;
  status: string;
  metadata: string;
  artifacts_dir: string | null;
  started_at: number | null;
  completed_at: number | null;
  last_activity_at: number | null;
  last_event_id: string | null;
}

interface RawNodeRow {
  run_id: string;
  node_id: string;
  state: string;
  output: string | null;
  session_id: string | null;
  error: string | null;
  started_at: number | null;
  completed_at: number | null;
}

interface RawEventRow {
  id: string;
  workflow_run_id: string;
  event_type: string;
  node_id: string | null;
  data: string;
  created_at: number;
}

export class SqliteWorkflowStore implements IWorkflowStore {
  constructor(private readonly db: Database.Database) {}

  // ─── runs ────────────────────────────────────────────────────────────────

  createRun(input: CreateRunInput): WorkflowRunRow {
    const now = Date.now();
    const metadata = input.metadata ?? {};
    this.db
      .prepare(
        `INSERT INTO workflow_runs (
           id, workflow_name, chat_jid, workspace_id, task_id, task_delegation_id,
           user_id, user_message, status, metadata, artifacts_dir,
           started_at, last_activity_at
         ) VALUES (
           @id, @workflow_name, @chat_jid, @workspace_id, @task_id, @task_delegation_id,
           @user_id, @user_message, 'pending', @metadata, @artifacts_dir,
           @now, @now
         )`,
      )
      .run({
        id: input.id,
        workflow_name: input.workflow_name,
        chat_jid: input.chat_jid ?? null,
        workspace_id: input.workspace_id ?? null,
        task_id: input.task_id ?? null,
        task_delegation_id: input.task_delegation_id ?? null,
        user_id: input.user_id ?? null,
        user_message: input.user_message,
        metadata: JSON.stringify(metadata),
        artifacts_dir: input.artifacts_dir ?? null,
        now,
      });
    const row = this.getRun(input.id);
    if (!row) throw new Error('unreachable: createRun inserted but getRun returned null');
    return row;
  }

  getRun(id: string): WorkflowRunRow | null {
    const raw = this.db
      .prepare(`SELECT * FROM workflow_runs WHERE id = ?`)
      .get(id) as RawRunRow | undefined;
    return raw ? rehydrateRun(raw) : null;
  }

  updateRunStatus(id: string, patch: UpdateRunStatusInput): WorkflowRunRow | null {
    const existing = this.getRun(id);
    if (!existing) return null;

    // Merge metadata. Caller-supplied `metadata` is a shallow merge; `approval`
    // is treated specially (top-level key on metadata).
    const nextMetadata: Record<string, unknown> = {
      ...existing.metadata,
      ...(patch.metadata ?? {}),
    };
    if (patch.approval === null) delete nextMetadata.approval;
    else if (patch.approval !== undefined) nextMetadata.approval = patch.approval;

    const now = Date.now();
    const isTerminal =
      patch.status === 'completed' ||
      patch.status === 'failed' ||
      patch.status === 'cancelled';
    const completed_at =
      patch.completed_at !== undefined
        ? patch.completed_at
        : isTerminal
          ? now
          : existing.completed_at;

    this.db
      .prepare(
        `UPDATE workflow_runs
            SET status = @status,
                metadata = @metadata,
                artifacts_dir = COALESCE(@artifacts_dir, artifacts_dir),
                last_activity_at = @now,
                completed_at = @completed_at,
                last_event_id = COALESCE(@last_event_id, last_event_id)
          WHERE id = @id`,
      )
      .run({
        id,
        status: patch.status,
        metadata: JSON.stringify(nextMetadata),
        artifacts_dir: patch.artifacts_dir ?? null,
        now,
        completed_at,
        last_event_id: patch.last_event_id ?? null,
      });

    return this.getRun(id);
  }

  listRunsByStatus(status: WorkflowRunStatus, limit = 100): WorkflowRunRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_runs WHERE status = ? ORDER BY last_activity_at DESC LIMIT ?`,
      )
      .all(status, limit) as RawRunRow[];
    return rows.map(rehydrateRun);
  }

  claimRun(
    pendingId: string,
    chatJid: string | null,
    cap: number,
  ): WorkflowRunRow | null {
    // Transaction: count running for jid, abort if at/above cap, else promote.
    const tx = this.db.transaction((id: string) => {
      const countRow = this.db
        .prepare(
          chatJid === null
            ? `SELECT COUNT(*) AS n FROM workflow_runs WHERE status = 'running' AND chat_jid IS NULL`
            : `SELECT COUNT(*) AS n FROM workflow_runs WHERE status = 'running' AND chat_jid = ?`,
        )
        .get(...(chatJid === null ? [] : [chatJid])) as { n: number };
      if (countRow.n >= cap) return false;

      // The pending run must still be pending; race-safe via WHERE clause.
      const upd = this.db
        .prepare(
          `UPDATE workflow_runs
              SET status = 'running',
                  last_activity_at = @now
            WHERE id = @id AND status = 'pending'`,
        )
        .run({ id, now: Date.now() });
      return upd.changes === 1;
    });
    const ok = tx(pendingId);
    if (!ok) return null;
    return this.getRun(pendingId);
  }

  // ─── per-node state ─────────────────────────────────────────────────────

  setNodeState(input: SetNodeStateInput): WorkflowRunNodeRow {
    const now = Date.now();
    const isTerminal =
      input.state === 'completed' || input.state === 'failed' || input.state === 'skipped';
    this.db
      .prepare(
        `INSERT INTO workflow_run_nodes (
           run_id, node_id, state, output, session_id, error, started_at, completed_at
         ) VALUES (
           @run_id, @node_id, @state, @output, @session_id, @error, @started_at, @completed_at
         )
         ON CONFLICT(run_id, node_id) DO UPDATE SET
           state = excluded.state,
           output = COALESCE(excluded.output, workflow_run_nodes.output),
           session_id = COALESCE(excluded.session_id, workflow_run_nodes.session_id),
           error = COALESCE(excluded.error, workflow_run_nodes.error),
           completed_at = CASE
             WHEN excluded.state IN ('completed', 'failed', 'skipped')
             THEN excluded.completed_at
             ELSE workflow_run_nodes.completed_at
           END`,
      )
      .run({
        run_id: input.run_id,
        node_id: input.node_id,
        state: input.state,
        output: input.output ?? null,
        session_id: input.session_id ?? null,
        error: input.error ?? null,
        started_at: input.state === 'running' ? now : null,
        completed_at: isTerminal ? now : null,
      });

    const raw = this.db
      .prepare(
        `SELECT * FROM workflow_run_nodes WHERE run_id = ? AND node_id = ?`,
      )
      .get(input.run_id, input.node_id) as RawNodeRow;
    return rehydrateNode(raw);
  }

  listNodesForRun(runId: string): WorkflowRunNodeRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_run_nodes WHERE run_id = ? ORDER BY node_id ASC`,
      )
      .all(runId) as RawNodeRow[];
    return rows.map(rehydrateNode);
  }

  // ─── events ─────────────────────────────────────────────────────────────

  appendEvent(input: AppendEventInput): WorkflowEventRow {
    const id = input.id || randomUUID();
    const now = Date.now();
    const data = JSON.stringify(input.data ?? {});
    this.db
      .prepare(
        `INSERT INTO workflow_events (id, workflow_run_id, event_type, node_id, data, created_at)
         VALUES (@id, @workflow_run_id, @event_type, @node_id, @data, @created_at)`,
      )
      .run({
        id,
        workflow_run_id: input.workflow_run_id,
        event_type: input.event_type,
        node_id: input.node_id ?? null,
        data,
        created_at: now,
      });

    // Update the run's `last_event_id` for mirror idempotency (Phase 6).
    this.db
      .prepare(
        `UPDATE workflow_runs SET last_event_id = ?, last_activity_at = ? WHERE id = ?`,
      )
      .run(id, now, input.workflow_run_id);

    return {
      id,
      workflow_run_id: input.workflow_run_id,
      event_type: input.event_type,
      node_id: input.node_id ?? null,
      data: input.data ?? {},
      created_at: now,
    };
  }

  listEventsForRun(runId: string, limit = 50): WorkflowEventRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_events WHERE workflow_run_id = ? ORDER BY created_at ASC LIMIT ?`,
      )
      .all(runId, limit) as RawEventRow[];
    return rows.map(rehydrateEvent);
  }
}

// ─── hydration helpers ──────────────────────────────────────────────────────

function rehydrateRun(raw: RawRunRow): WorkflowRunRow {
  return {
    id: raw.id,
    workflow_name: raw.workflow_name,
    chat_jid: raw.chat_jid,
    workspace_id: raw.workspace_id,
    task_id: raw.task_id,
    task_delegation_id: raw.task_delegation_id,
    user_id: raw.user_id,
    user_message: raw.user_message,
    status: raw.status as WorkflowRunStatus,
    metadata: parseJson(raw.metadata, {}),
    artifacts_dir: raw.artifacts_dir,
    started_at: raw.started_at,
    completed_at: raw.completed_at,
    last_activity_at: raw.last_activity_at,
    last_event_id: raw.last_event_id,
  };
}

function rehydrateNode(raw: RawNodeRow): WorkflowRunNodeRow {
  return {
    run_id: raw.run_id,
    node_id: raw.node_id,
    state: raw.state as WorkflowRunNodeRow['state'],
    output: raw.output,
    session_id: raw.session_id,
    error: raw.error,
    started_at: raw.started_at,
    completed_at: raw.completed_at,
  };
}

function rehydrateEvent(raw: RawEventRow): WorkflowEventRow {
  return {
    id: raw.id,
    workflow_run_id: raw.workflow_run_id,
    event_type: raw.event_type,
    node_id: raw.node_id,
    data: parseJson(raw.data, {}),
    created_at: raw.created_at,
  };
}

function parseJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** Re-export of ApprovalContext for callers that build the store wrapper themselves. */
export type { ApprovalContext };
