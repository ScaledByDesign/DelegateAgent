// ─── Phase 6c — workflow-mirror tests ───
//
// Coverage:
//   - mirror disabled by env → skip (return true)
//   - workspace_id NULL → skip
//   - missing token → skip
//   - happy path POST → returns true + correct payload shape
//   - server non-2xx → returns false (does not throw)
//   - fetch rejection → returns false (does not throw)
//   - same lastEventId emitted twice → 2 POSTs (executor side); server
//     decides idempotency (we just verify both POSTs reach the wire so the
//     server's mirrored DB compare path runs)
//   - chat_jid → agentJid field rename on the wire
//   - loop_state still present in payload (server strips, not us)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _closeDatabase, _initTestDatabase, _getDb } from '../../db.js';
import { SqliteWorkflowStore } from '../store/sqlite-workflow-store.js';
import {
  _resetMirrorEnabledCache,
  buildMirrorPayload,
  isLifecycleEventType,
  isMirrorEnabled,
  mirrorWorkflowRunState,
} from './workflow-mirror.js';

describe('workflow-mirror — enable flag', () => {
  beforeEach(() => {
    _resetMirrorEnabledCache();
    delete process.env.ARCHON_WORKFLOW_MIRROR_ENABLED;
  });

  it('is disabled by default', () => {
    expect(isMirrorEnabled()).toBe(false);
  });

  it('parses "1" as enabled', () => {
    process.env.ARCHON_WORKFLOW_MIRROR_ENABLED = '1';
    _resetMirrorEnabledCache();
    expect(isMirrorEnabled()).toBe(true);
  });

  it('parses "true" (case-insensitive) as enabled', () => {
    process.env.ARCHON_WORKFLOW_MIRROR_ENABLED = 'TRUE';
    _resetMirrorEnabledCache();
    expect(isMirrorEnabled()).toBe(true);
  });

  it('caches the read — toggling env after first read has no effect until reset', () => {
    process.env.ARCHON_WORKFLOW_MIRROR_ENABLED = '1';
    _resetMirrorEnabledCache();
    expect(isMirrorEnabled()).toBe(true);
    delete process.env.ARCHON_WORKFLOW_MIRROR_ENABLED;
    expect(isMirrorEnabled()).toBe(true); // cached
    _resetMirrorEnabledCache();
    expect(isMirrorEnabled()).toBe(false);
  });
});

describe('workflow-mirror — lifecycle event filter', () => {
  it('matches all 6 lifecycle events', () => {
    expect(isLifecycleEventType('workflow.run_started')).toBe(true);
    expect(isLifecycleEventType('workflow.run_completed')).toBe(true);
    expect(isLifecycleEventType('workflow.run_failed')).toBe(true);
    expect(isLifecycleEventType('workflow.run_cancelled')).toBe(true);
    expect(isLifecycleEventType('workflow.run_paused')).toBe(true);
    expect(isLifecycleEventType('workflow.run_resumed')).toBe(true);
  });

  it('rejects per-node events', () => {
    expect(isLifecycleEventType('dag.node_started')).toBe(false);
    expect(isLifecycleEventType('dag.bash_completed')).toBe(false);
    expect(isLifecycleEventType('dag.prompt_failed')).toBe(false);
  });
});

describe('workflow-mirror — buildMirrorPayload', () => {
  it('renames chat_jid → agentJid', () => {
    const payload = buildMirrorPayload({
      id: 'run-1',
      workflow_name: 'wf',
      chat_jid: 'delegate:main',
      workspace_id: 'ws-1',
      task_id: null,
      task_delegation_id: null,
      user_id: null,
      user_message: 'hi',
      status: 'running',
      metadata: {},
      artifacts_dir: null,
      started_at: 1000,
      completed_at: null,
      last_activity_at: 1001,
      last_event_id: null,
    });
    expect(payload.agentJid).toBe('delegate:main');
    // The wire shape does NOT have chat_jid by name — the server's mapper
    // accepts it for back-compat but we always emit agentJid.
    expect((payload as Record<string, unknown>).chat_jid).toBeUndefined();
  });

  it('passes metadata through verbatim (server strips loop_state)', () => {
    const payload = buildMirrorPayload({
      id: 'run-1',
      workflow_name: 'wf',
      chat_jid: null,
      workspace_id: 'ws-1',
      task_id: null,
      task_delegation_id: null,
      user_id: null,
      user_message: 'hi',
      status: 'paused',
      metadata: {
        loop_state: { nodeA: { iter: 3 } },
        approval: { node_id: 'x' },
      },
      artifacts_dir: null,
      started_at: null,
      completed_at: null,
      last_activity_at: null,
      last_event_id: null,
    });
    expect(payload.metadata).toEqual({
      loop_state: { nodeA: { iter: 3 } },
      approval: { node_id: 'x' },
    });
  });

  it('maps timestamps to *Ms suffix', () => {
    const payload = buildMirrorPayload({
      id: 'run-1',
      workflow_name: 'wf',
      chat_jid: null,
      workspace_id: 'ws-1',
      task_id: null,
      task_delegation_id: null,
      user_id: null,
      user_message: 'hi',
      status: 'completed',
      metadata: {},
      artifacts_dir: null,
      started_at: 100,
      completed_at: 200,
      last_activity_at: 150,
      last_event_id: 'evt-9',
    });
    expect(payload.startedAtMs).toBe(100);
    expect(payload.completedAtMs).toBe(200);
    expect(payload.lastActivityAtMs).toBe(150);
    expect(payload.lastEventId).toBe('evt-9');
  });

  it('attaches extra channel-renderer fields when supplied', () => {
    const payload = buildMirrorPayload(
      {
        id: 'run-1',
        workflow_name: 'wf',
        chat_jid: null,
        workspace_id: 'ws-1',
        task_id: null,
        task_delegation_id: null,
        user_id: null,
        user_message: 'hi',
        status: 'paused',
        metadata: {},
        artifacts_dir: null,
        started_at: null,
        completed_at: null,
        last_activity_at: null,
        last_event_id: null,
      },
      {
        message: 'Approve to continue',
        approvalType: 'approval',
        nodeId: 'gate-1',
        iteration: 2,
        failedNodes: ['a', 'b'],
      },
    );
    expect(payload.message).toBe('Approve to continue');
    expect(payload.approvalType).toBe('approval');
    expect(payload.nodeId).toBe('gate-1');
    expect(payload.iteration).toBe(2);
    expect(payload.failedNodes).toEqual(['a', 'b']);
  });
});

describe('workflow-mirror — POST happy + skip paths', () => {
  let store: SqliteWorkflowStore;
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    _initTestDatabase();
    store = new SqliteWorkflowStore(_getDb());
    _resetMirrorEnabledCache();
    process.env.ARCHON_WORKFLOW_MIRROR_ENABLED = '1';
    process.env.DELEGATE_AGENT_TOKEN = 'test-token';
    process.env.DELEGATE_URL = 'https://test.delegate.ws';
  });

  afterEach(() => {
    _closeDatabase();
    process.env = { ...ORIG_ENV };
    _resetMirrorEnabledCache();
  });

  it('skips (true) when mirror disabled', async () => {
    delete process.env.ARCHON_WORKFLOW_MIRROR_ENABLED;
    _resetMirrorEnabledCache();
    const fetchFn = vi.fn();
    const ok = await mirrorWorkflowRunState('nope', {
      store,
      deps: { fetch: fetchFn as unknown as typeof fetch },
    });
    expect(ok).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('skips (true) when run not found', async () => {
    const fetchFn = vi.fn();
    const ok = await mirrorWorkflowRunState('missing', {
      store,
      deps: { fetch: fetchFn as unknown as typeof fetch },
    });
    expect(ok).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('skips (true) when workspace_id is NULL', async () => {
    store.createRun({
      id: 'run-no-ws',
      workflow_name: 'wf',
      user_message: 'hi',
      workspace_id: null,
    });
    const fetchFn = vi.fn();
    const ok = await mirrorWorkflowRunState('run-no-ws', {
      store,
      deps: { fetch: fetchFn as unknown as typeof fetch },
    });
    expect(ok).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('skips (true) when DELEGATE_AGENT_TOKEN is missing', async () => {
    delete process.env.DELEGATE_AGENT_TOKEN;
    delete process.env.DELEGATE_API_KEY;
    store.createRun({
      id: 'run-1',
      workflow_name: 'wf',
      user_message: 'hi',
      workspace_id: 'ws-1',
    });
    const fetchFn = vi.fn();
    const ok = await mirrorWorkflowRunState('run-1', {
      store,
      deps: { fetch: fetchFn as unknown as typeof fetch },
    });
    expect(ok).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('POSTs on happy path with bearer + correct URL', async () => {
    store.createRun({
      id: 'run-1',
      workflow_name: 'wf',
      user_message: 'hi',
      workspace_id: 'ws-1',
      chat_jid: 'delegate:main',
    });
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => '',
    } as Response);
    const ok = await mirrorWorkflowRunState('run-1', {
      store,
      deps: { fetch: fetchFn as unknown as typeof fetch },
    });
    expect(ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://test.delegate.ws/api/agent/workflow/runs');
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer test-token',
    );
    const body = JSON.parse(init.body as string);
    expect(body.workflowRunId).toBe('run-1');
    expect(body.workspaceId).toBe('ws-1');
    expect(body.agentJid).toBe('delegate:main');
    expect(body.status).toBe('pending');
  });

  it('returns false on non-2xx', async () => {
    store.createRun({
      id: 'run-1',
      workflow_name: 'wf',
      user_message: 'hi',
      workspace_id: 'ws-1',
    });
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'boom',
    } as Response);
    const ok = await mirrorWorkflowRunState('run-1', {
      store,
      deps: { fetch: fetchFn as unknown as typeof fetch },
    });
    expect(ok).toBe(false);
  });

  it('returns false on fetch rejection (does not throw)', async () => {
    store.createRun({
      id: 'run-1',
      workflow_name: 'wf',
      user_message: 'hi',
      workspace_id: 'ws-1',
    });
    const fetchFn = vi
      .fn()
      .mockRejectedValue(new Error('connect ECONNREFUSED'));
    const ok = await mirrorWorkflowRunState('run-1', {
      store,
      deps: { fetch: fetchFn as unknown as typeof fetch },
    });
    expect(ok).toBe(false);
  });

  it('idempotent retry — same run state POSTed twice triggers 2 wire-level POSTs (server enforces idempotency)', async () => {
    store.createRun({
      id: 'run-1',
      workflow_name: 'wf',
      user_message: 'hi',
      workspace_id: 'ws-1',
    });
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    } as Response);
    await mirrorWorkflowRunState('run-1', {
      store,
      deps: { fetch: fetchFn as unknown as typeof fetch },
    });
    await mirrorWorkflowRunState('run-1', {
      store,
      deps: { fetch: fetchFn as unknown as typeof fetch },
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // Both bodies are byte-identical — server's lastEventId compare yields
    // one DB write + one LiveEvent emit (the second is a 200-idempotent).
    const body1 = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string);
    const body2 = JSON.parse(fetchFn.mock.calls[1]![1]!.body as string);
    expect(body1).toEqual(body2);
  });
});
