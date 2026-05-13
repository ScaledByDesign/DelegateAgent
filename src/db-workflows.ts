/**
 * Phase 1.5 — SQLite persistence for the DAG workflow engine.
 *
 * Three tables (all CREATE TABLE IF NOT EXISTS — idempotent migrations):
 *   - `workflow_runs`     — one row per run; tracks status, jid, workspace, task linkage.
 *   - `workflow_run_nodes` — per-node state + captured output; cascades on run delete.
 *   - `workflow_events`   — JSONL event log mirror; cascades on run delete.
 *
 * WAL mode is asserted here (idempotent — re-applying `PRAGMA journal_mode=WAL`
 * is harmless). Existing tables in `messages.db` benefit from WAL too.
 *
 * Schema versioning via `PRAGMA user_version`. Bump by 1 each time the tables
 * gain a new column or index. The current target version is 1 (Phase 1.5
 * baseline). Downstream phases (1.7, 2, 3, 4) do NOT bump this — only schema
 * migrations under this module own the user_version bump.
 *
 * Restart sweep: callers invoke `sweepOrphanedRunningRuns(db)` on init to flip
 * any `running` rows to `failed{orphaned_by_restart}`. `paused` rows are left
 * alone (they have external resume contracts).
 */
import type Database from 'better-sqlite3';

/** Schema version managed by this module. Bump when adding columns/indexes. */
export const WORKFLOW_SCHEMA_VERSION = 1;

/** Apply (or re-apply, idempotent) the workflow_* tables + indexes to `database`. */
export function createWorkflowSchema(database: Database.Database): void {
  database.exec(`PRAGMA journal_mode = WAL`);

  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      chat_jid TEXT,
      workspace_id TEXT,
      task_id TEXT,
      task_delegation_id TEXT,
      user_id TEXT,
      user_message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      metadata TEXT NOT NULL DEFAULT '{}',
      artifacts_dir TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      last_activity_at INTEGER,
      last_event_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wf_runs_status      ON workflow_runs(status, last_activity_at);
    CREATE INDEX IF NOT EXISTS idx_wf_runs_task        ON workflow_runs(task_id);
    CREATE INDEX IF NOT EXISTS idx_wf_runs_workspace   ON workflow_runs(workspace_id, status);
    CREATE INDEX IF NOT EXISTS idx_wf_runs_jid_status  ON workflow_runs(chat_jid, status);

    CREATE TABLE IF NOT EXISTS workflow_run_nodes (
      run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      state TEXT NOT NULL,
      output TEXT,
      session_id TEXT,
      error TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      PRIMARY KEY (run_id, node_id)
    );

    CREATE TABLE IF NOT EXISTS workflow_events (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      node_id TEXT,
      data TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wf_events_run ON workflow_events(workflow_run_id, created_at);
  `);

  bumpUserVersionIfBelow(database, WORKFLOW_SCHEMA_VERSION);
}

/**
 * On agent boot, flip any `running` rows to `failed{orphaned_by_restart}` —
 * the executor's in-memory AbortController for those runs is gone, so they
 * are not resumable. `paused` rows are NOT touched (per plan R5).
 *
 * Returns the number of rows updated so the caller can log + emit a Sentry
 * breadcrumb if the count is non-zero.
 */
export function sweepOrphanedRunningRuns(database: Database.Database): number {
  const now = Date.now();
  const stmt = database.prepare(
    `UPDATE workflow_runs
        SET status = 'failed',
            metadata = json_patch(metadata, json_object('orphaned_at', @now, 'orphan_reason', 'orphaned_by_restart')),
            completed_at = @now,
            last_activity_at = @now
      WHERE status = 'running'`,
  );
  const result = stmt.run({ now });
  return result.changes;
}

/** Read current `PRAGMA user_version`. */
export function getUserVersion(database: Database.Database): number {
  const row = database.prepare(`PRAGMA user_version`).get() as {
    user_version: number;
  };
  return row.user_version;
}

/** Bump `PRAGMA user_version` to `target` if currently lower. Idempotent. */
function bumpUserVersionIfBelow(
  database: Database.Database,
  target: number,
): void {
  const current = getUserVersion(database);
  if (current < target) {
    // PRAGMA user_version doesn't accept bound params; safe because target is a
    // module-internal constant, not user input.
    database.exec(`PRAGMA user_version = ${target}`);
  }
}
