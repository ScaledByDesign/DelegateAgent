import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  WORKFLOW_SCHEMA_VERSION,
  createWorkflowSchema,
  getUserVersion,
  sweepOrphanedRunningRuns,
} from './db-workflows.js';
import { SqliteWorkflowStore } from './workflows/store/sqlite-workflow-store.js';

let db: Database.Database;
let store: SqliteWorkflowStore;

beforeEach(() => {
  db = new Database(':memory:');
  createWorkflowSchema(db);
  store = new SqliteWorkflowStore(db);
});

afterEach(() => {
  db.close();
});

// ─── schema migrations ─────────────────────────────────────────────────────

describe('createWorkflowSchema', () => {
  it('is idempotent — second invocation does not throw', () => {
    expect(() => createWorkflowSchema(db)).not.toThrow();
  });

  it('sets PRAGMA journal_mode=wal', () => {
    const row = db.prepare('PRAGMA journal_mode').get() as {
      journal_mode: string;
    };
    // In-memory DBs report `memory`, not `wal` — that's fine; the call itself
    // is idempotent and harmless. For file-backed DBs we'd see `wal`.
    expect(['wal', 'memory']).toContain(row.journal_mode);
  });

  it('bumps user_version to current schema version', () => {
    expect(getUserVersion(db)).toBe(WORKFLOW_SCHEMA_VERSION);
  });

  it('does NOT lower user_version if already higher', () => {
    db.exec(`PRAGMA user_version = 99`);
    createWorkflowSchema(db);
    expect(getUserVersion(db)).toBe(99);
  });
});

// ─── createRun / getRun ────────────────────────────────────────────────────

describe('createRun + getRun round-trip', () => {
  it('persists all fields including null defaults', () => {
    const row = store.createRun({
      id: 'run-1',
      workflow_name: 'demo',
      user_message: 'hello',
      chat_jid: '12345@s.whatsapp.net',
      workspace_id: 'ws-1',
    });

    expect(row.id).toBe('run-1');
    expect(row.workflow_name).toBe('demo');
    expect(row.status).toBe('pending');
    expect(row.chat_jid).toBe('12345@s.whatsapp.net');
    expect(row.workspace_id).toBe('ws-1');
    expect(row.task_id).toBeNull();
    expect(row.task_delegation_id).toBeNull();
    expect(row.metadata).toEqual({});
    expect(typeof row.started_at).toBe('number');
    expect(row.completed_at).toBeNull();

    const fetched = store.getRun('run-1');
    expect(fetched).toEqual(row);
  });

  it('returns null for unknown id', () => {
    expect(store.getRun('missing')).toBeNull();
  });

  it('rejects duplicate id', () => {
    store.createRun({ id: 'run-1', workflow_name: 'demo', user_message: 'x' });
    expect(() =>
      store.createRun({
        id: 'run-1',
        workflow_name: 'demo',
        user_message: 'x',
      }),
    ).toThrow();
  });
});

// ─── updateRunStatus ───────────────────────────────────────────────────────

describe('updateRunStatus', () => {
  beforeEach(() => {
    store.createRun({
      id: 'run-1',
      workflow_name: 'demo',
      user_message: 'x',
      chat_jid: 'jid',
    });
  });

  it('flips pending → running and stamps last_activity_at', () => {
    const before = store.getRun('run-1')!;
    const updated = store.updateRunStatus('run-1', { status: 'running' });
    expect(updated?.status).toBe('running');
    expect(updated!.last_activity_at!).toBeGreaterThanOrEqual(
      before.last_activity_at!,
    );
  });

  it('flips to completed and sets completed_at', () => {
    const updated = store.updateRunStatus('run-1', { status: 'completed' });
    expect(updated?.status).toBe('completed');
    expect(typeof updated?.completed_at).toBe('number');
  });

  it('persists ApprovalContext under metadata.approval', () => {
    const updated = store.updateRunStatus('run-1', {
      status: 'paused',
      approval: {
        nodeId: 'approve',
        message: 'Approve sprint?',
        type: 'approval',
      },
    });
    expect(updated?.status).toBe('paused');
    expect(updated?.metadata.approval).toEqual({
      nodeId: 'approve',
      message: 'Approve sprint?',
      type: 'approval',
    });
  });

  it('clears approval when patch sets approval: null', () => {
    store.updateRunStatus('run-1', {
      status: 'paused',
      approval: { nodeId: 'a', message: 'Approve?' },
    });
    const cleared = store.updateRunStatus('run-1', {
      status: 'running',
      approval: null,
    });
    expect(cleared?.metadata.approval).toBeUndefined();
  });

  it('shallow-merges supplied metadata into existing', () => {
    store.updateRunStatus('run-1', {
      status: 'running',
      metadata: { foo: 'bar' },
    });
    const updated = store.updateRunStatus('run-1', {
      status: 'running',
      metadata: { baz: 'qux' },
    });
    expect(updated?.metadata).toEqual({ foo: 'bar', baz: 'qux' });
  });

  it('returns null for unknown run id', () => {
    expect(store.updateRunStatus('missing', { status: 'running' })).toBeNull();
  });
});

// ─── listRunsByStatus ─────────────────────────────────────────────────────

describe('listRunsByStatus', () => {
  it('filters by status', () => {
    store.createRun({ id: 'r1', workflow_name: 'demo', user_message: 'x' });
    store.createRun({ id: 'r2', workflow_name: 'demo', user_message: 'x' });
    store.updateRunStatus('r2', { status: 'running' });

    const pending = store.listRunsByStatus('pending');
    const running = store.listRunsByStatus('running');
    expect(pending.map((r) => r.id)).toEqual(['r1']);
    expect(running.map((r) => r.id)).toEqual(['r2']);
  });
});

// ─── claimRun (concurrency cap) ────────────────────────────────────────────

describe('claimRun', () => {
  it('promotes pending → running when under cap', () => {
    store.createRun({
      id: 'r1',
      workflow_name: 'demo',
      user_message: 'x',
      chat_jid: 'jid',
    });
    const claimed = store.claimRun('r1', 'jid', 4);
    expect(claimed?.status).toBe('running');
    expect(store.getRun('r1')?.status).toBe('running');
  });

  it('returns null when cap is reached for the chat_jid', () => {
    for (let i = 0; i < 4; i++) {
      store.createRun({
        id: `r${i}`,
        workflow_name: 'demo',
        user_message: 'x',
        chat_jid: 'jid',
      });
      store.updateRunStatus(`r${i}`, { status: 'running' });
    }
    store.createRun({
      id: 'over',
      workflow_name: 'demo',
      user_message: 'x',
      chat_jid: 'jid',
    });
    const claimed = store.claimRun('over', 'jid', 4);
    expect(claimed).toBeNull();
    expect(store.getRun('over')?.status).toBe('pending');
  });

  it('separate jids have separate cap windows', () => {
    for (let i = 0; i < 4; i++) {
      store.createRun({
        id: `a${i}`,
        workflow_name: 'demo',
        user_message: 'x',
        chat_jid: 'jid-a',
      });
      store.updateRunStatus(`a${i}`, { status: 'running' });
    }
    store.createRun({
      id: 'b0',
      workflow_name: 'demo',
      user_message: 'x',
      chat_jid: 'jid-b',
    });
    const claimed = store.claimRun('b0', 'jid-b', 4);
    expect(claimed?.status).toBe('running');
  });

  it('null chat_jid is its own bucket and still bounded', () => {
    for (let i = 0; i < 2; i++) {
      store.createRun({
        id: `n${i}`,
        workflow_name: 'demo',
        user_message: 'x',
      });
      store.updateRunStatus(`n${i}`, { status: 'running' });
    }
    store.createRun({ id: 'over', workflow_name: 'demo', user_message: 'x' });
    expect(store.claimRun('over', null, 2)).toBeNull();
    expect(store.getRun('over')?.status).toBe('pending');
  });

  it('does NOT promote a non-pending row', () => {
    store.createRun({
      id: 'r1',
      workflow_name: 'demo',
      user_message: 'x',
      chat_jid: 'jid',
    });
    store.updateRunStatus('r1', { status: 'failed' });
    expect(store.claimRun('r1', 'jid', 4)).toBeNull();
  });
});

// ─── setNodeState / listNodesForRun ────────────────────────────────────────

describe('setNodeState + listNodesForRun', () => {
  beforeEach(() => {
    store.createRun({ id: 'r1', workflow_name: 'demo', user_message: 'x' });
  });

  it('upserts a node and persists output', () => {
    store.setNodeState({ run_id: 'r1', node_id: 'a', state: 'running' });
    store.setNodeState({
      run_id: 'r1',
      node_id: 'a',
      state: 'completed',
      output: 'hello\n',
    });
    const nodes = store.listNodesForRun('r1');
    expect(nodes.length).toBe(1);
    expect(nodes[0].node_id).toBe('a');
    expect(nodes[0].state).toBe('completed');
    expect(nodes[0].output).toBe('hello\n');
  });

  it('persists failed state with error message', () => {
    store.setNodeState({
      run_id: 'r1',
      node_id: 'x',
      state: 'failed',
      error: 'TRANSIENT: exited with code 1',
    });
    const nodes = store.listNodesForRun('r1');
    expect(nodes[0].state).toBe('failed');
    expect(nodes[0].error).toMatch(/TRANSIENT/);
  });

  it('cascades on run delete (ON DELETE CASCADE)', () => {
    store.setNodeState({ run_id: 'r1', node_id: 'a', state: 'completed' });
    db.prepare(`DELETE FROM workflow_runs WHERE id = ?`).run('r1');
    expect(store.listNodesForRun('r1')).toEqual([]);
  });
});

// ─── appendEvent / listEventsForRun ────────────────────────────────────────

describe('appendEvent + listEventsForRun', () => {
  beforeEach(() => {
    store.createRun({ id: 'r1', workflow_name: 'demo', user_message: 'x' });
  });

  it('appends events in order and updates last_event_id', () => {
    const e1 = store.appendEvent({
      id: 'evt-1',
      workflow_run_id: 'r1',
      event_type: 'run.started',
    });
    const e2 = store.appendEvent({
      id: 'evt-2',
      workflow_run_id: 'r1',
      event_type: 'node.started',
      node_id: 'a',
    });
    expect(e1.event_type).toBe('run.started');
    expect(e2.node_id).toBe('a');

    const events = store.listEventsForRun('r1');
    expect(events.length).toBe(2);
    expect(events[0].event_type).toBe('run.started');
    expect(events[1].event_type).toBe('node.started');

    const run = store.getRun('r1');
    expect(run?.last_event_id).toBe('evt-2');
  });

  it('cascades on run delete', () => {
    store.appendEvent({
      id: 'evt-1',
      workflow_run_id: 'r1',
      event_type: 'run.started',
    });
    db.prepare(`DELETE FROM workflow_runs WHERE id = ?`).run('r1');
    expect(store.listEventsForRun('r1')).toEqual([]);
  });

  it('respects limit', () => {
    for (let i = 0; i < 10; i++) {
      store.appendEvent({
        id: `evt-${i}`,
        workflow_run_id: 'r1',
        event_type: `e${i}`,
      });
    }
    expect(store.listEventsForRun('r1', 3).length).toBe(3);
  });
});

// ─── sweepOrphanedRunningRuns ──────────────────────────────────────────────

describe('sweepOrphanedRunningRuns', () => {
  it('flips running → failed with orphan_reason metadata', () => {
    store.createRun({ id: 'r1', workflow_name: 'demo', user_message: 'x' });
    store.updateRunStatus('r1', { status: 'running' });

    const updated = sweepOrphanedRunningRuns(db);
    expect(updated).toBe(1);

    const row = store.getRun('r1');
    expect(row?.status).toBe('failed');
    expect(row?.metadata.orphan_reason).toBe('orphaned_by_restart');
    expect(row?.metadata.orphaned_at).toBeDefined();
  });

  it('leaves paused rows alone', () => {
    store.createRun({ id: 'r1', workflow_name: 'demo', user_message: 'x' });
    store.updateRunStatus('r1', {
      status: 'paused',
      approval: { nodeId: 'a', message: 'Approve?' },
    });

    const updated = sweepOrphanedRunningRuns(db);
    expect(updated).toBe(0);
    expect(store.getRun('r1')?.status).toBe('paused');
  });

  it('returns 0 when no running rows exist', () => {
    expect(sweepOrphanedRunningRuns(db)).toBe(0);
  });
});
