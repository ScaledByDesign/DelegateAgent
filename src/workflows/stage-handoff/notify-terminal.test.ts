// ─── Phase 6d — stage-handoff notify-terminal tests ───
//
// Coverage:
//   - enable flag: default off, "1"/"true" on, cache toggle
//   - stageHandoffStatusForEvent: only completed/failed match
//   - terminalToAgentStatus: completed→success, failed→error
//   - notify skip paths: disabled, missing run, no delegation, jid not
//     delegate:task:*, status not completed/failed, missing token
//   - notify happy path: POST hits correct URL with bearer + correct body
//   - 404 from receiver tolerated (return true)
//   - non-2xx → false
//   - fetch reject → false
//   - body shape: jid + metadata.terminal:true + agentStatus + workflowRunId

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── JWT mint mock ───────────────────────────────────────────────────────────
// notifyDelegationTerminal calls mintAgentJWT (globalThis.fetch internally).
// The tests use an injectable deps.fetch seam for the actual POST, but
// mintAgentJWT bypasses that seam and hits globalThis.fetch separately.
// Mocking mintAgentJWT to return null causes the implementation to fall back to
// DELEGATE_AGENT_TOKEN, so the injectable deps.fetch receives the correct
// bearer and the test assertions on fetchFn.mock.calls remain accurate.
vi.mock('../../jwt-mint.js', () => ({
  mintAgentJWT: vi.fn().mockResolvedValue(null),
}));

import { _closeDatabase, _initTestDatabase, _getDb } from '../../db.js';
import { SqliteWorkflowStore } from '../store/sqlite-workflow-store.js';
import {
  _resetStageHandoffEnabledCache,
  isStageHandoffEnabled,
  notifyDelegationTerminal,
  stageHandoffStatusForEvent,
  terminalToAgentStatus,
} from './notify-terminal.js';

describe('stage-handoff — enable flag', () => {
  beforeEach(() => {
    _resetStageHandoffEnabledCache();
    delete process.env.ARCHON_WORKFLOW_STAGE_HANDOFF_ENABLED;
  });

  it('is disabled by default', () => {
    expect(isStageHandoffEnabled()).toBe(false);
  });

  it('parses "1" as enabled', () => {
    process.env.ARCHON_WORKFLOW_STAGE_HANDOFF_ENABLED = '1';
    _resetStageHandoffEnabledCache();
    expect(isStageHandoffEnabled()).toBe(true);
  });

  it('parses "true" (case-insensitive) as enabled', () => {
    process.env.ARCHON_WORKFLOW_STAGE_HANDOFF_ENABLED = 'TRUE';
    _resetStageHandoffEnabledCache();
    expect(isStageHandoffEnabled()).toBe(true);
  });

  it('caches the read — toggling env after first read has no effect until reset', () => {
    process.env.ARCHON_WORKFLOW_STAGE_HANDOFF_ENABLED = '1';
    _resetStageHandoffEnabledCache();
    expect(isStageHandoffEnabled()).toBe(true);
    delete process.env.ARCHON_WORKFLOW_STAGE_HANDOFF_ENABLED;
    expect(isStageHandoffEnabled()).toBe(true);
    _resetStageHandoffEnabledCache();
    expect(isStageHandoffEnabled()).toBe(false);
  });
});

describe('stage-handoff — event filter', () => {
  it('matches only completed/failed lifecycle events', () => {
    expect(stageHandoffStatusForEvent('workflow.run_completed')).toBe(
      'completed',
    );
    expect(stageHandoffStatusForEvent('workflow.run_failed')).toBe('failed');
  });

  it('does NOT match started/paused/cancelled/resumed', () => {
    expect(stageHandoffStatusForEvent('workflow.run_started')).toBe(null);
    expect(stageHandoffStatusForEvent('workflow.run_paused')).toBe(null);
    expect(stageHandoffStatusForEvent('workflow.run_cancelled')).toBe(null);
    expect(stageHandoffStatusForEvent('workflow.run_resumed')).toBe(null);
  });

  it('does NOT match per-node events', () => {
    expect(stageHandoffStatusForEvent('dag.node_completed')).toBe(null);
    expect(stageHandoffStatusForEvent('dag.bash_failed')).toBe(null);
  });
});

describe('stage-handoff — terminalToAgentStatus', () => {
  it('completed → success', () => {
    expect(terminalToAgentStatus('completed')).toBe('success');
  });
  it('failed → error', () => {
    expect(terminalToAgentStatus('failed')).toBe('error');
  });
});

describe('stage-handoff — notifyDelegationTerminal', () => {
  let store: SqliteWorkflowStore;
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    _initTestDatabase();
    store = new SqliteWorkflowStore(_getDb());
    _resetStageHandoffEnabledCache();
    process.env.ARCHON_WORKFLOW_STAGE_HANDOFF_ENABLED = '1';
    process.env.DELEGATE_AGENT_TOKEN = 'test-token';
    process.env.DELEGATE_URL = 'https://test.delegate.ws';
  });

  afterEach(() => {
    _closeDatabase();
    process.env = { ...ORIG_ENV };
    _resetStageHandoffEnabledCache();
  });

  function createRunWith(overrides: {
    chat_jid?: string | null;
    task_delegation_id?: string | null;
    workspace_id?: string | null;
  }): void {
    store.createRun({
      id: 'run-1',
      workflow_name: 'wf',
      user_message: 'hi',
      workspace_id:
        'workspace_id' in overrides ? overrides.workspace_id : 'ws-1',
      chat_jid:
        'chat_jid' in overrides ? overrides.chat_jid : 'delegate:task:t-1',
      task_delegation_id:
        'task_delegation_id' in overrides
          ? overrides.task_delegation_id
          : 'd-1',
    });
  }

  it('skips (true) when stage-handoff disabled', async () => {
    delete process.env.ARCHON_WORKFLOW_STAGE_HANDOFF_ENABLED;
    _resetStageHandoffEnabledCache();
    createRunWith({});
    const fetchFn = vi.fn();
    const ok = await notifyDelegationTerminal('run-1', 'completed', {
      store,
      deps: { fetch: fetchFn as unknown as typeof fetch },
    });
    expect(ok).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('skips (true) when run not found', async () => {
    const fetchFn = vi.fn();
    const ok = await notifyDelegationTerminal('missing', 'completed', {
      store,
      deps: { fetch: fetchFn as unknown as typeof fetch },
    });
    expect(ok).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('skips (true) when task_delegation_id is missing', async () => {
    createRunWith({ task_delegation_id: null });
    const fetchFn = vi.fn();
    const ok = await notifyDelegationTerminal('run-1', 'completed', {
      store,
      deps: { fetch: fetchFn as unknown as typeof fetch },
    });
    expect(ok).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('skips (true) when chat_jid is null', async () => {
    createRunWith({ chat_jid: null });
    const fetchFn = vi.fn();
    const ok = await notifyDelegationTerminal('run-1', 'completed', {
      store,
      deps: { fetch: fetchFn as unknown as typeof fetch },
    });
    expect(ok).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('skips (true) when chat_jid does NOT start with delegate:task:', async () => {
    createRunWith({ chat_jid: 'delegate:conv:c-1' });
    const fetchFn = vi.fn();
    const ok = await notifyDelegationTerminal('run-1', 'completed', {
      store,
      deps: { fetch: fetchFn as unknown as typeof fetch },
    });
    expect(ok).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('skips (true) when status is not completed/failed', async () => {
    createRunWith({});
    const fetchFn = vi.fn();
    // Using cast to defeat TS — runtime check is what we're testing.
    const ok = await notifyDelegationTerminal(
      'run-1',
      'paused' as unknown as 'completed',
      {
        store,
        deps: { fetch: fetchFn as unknown as typeof fetch },
      },
    );
    expect(ok).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('skips (true) when token missing', async () => {
    delete process.env.DELEGATE_AGENT_TOKEN;
    delete process.env.DELEGATE_API_KEY;
    createRunWith({});
    const fetchFn = vi.fn();
    const ok = await notifyDelegationTerminal('run-1', 'completed', {
      store,
      deps: { fetch: fetchFn as unknown as typeof fetch },
    });
    expect(ok).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('POSTs on completed → metadata.agentStatus=success, terminal=true', async () => {
    createRunWith({});
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    } as Response);
    const ok = await notifyDelegationTerminal('run-1', 'completed', {
      store,
      deps: { fetch: fetchFn as unknown as typeof fetch },
    });
    expect(ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://test.delegate.ws/api/agent/channel/reply');
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer test-token',
    );
    const body = JSON.parse(init.body as string);
    expect(body.jid).toBe('delegate:task:t-1');
    expect(body.metadata.terminal).toBe(true);
    expect(body.metadata.agentStatus).toBe('success');
    expect(body.metadata.source).toBe('delegate-agent-workflow');
    expect(body.metadata.workflowRunId).toBe('run-1');
    expect(body.metadata.workflowName).toBe('wf');
    expect(body.metadata.taskDelegationId).toBe('d-1');
    // Defense check: no text field, since the user-visible reply was
    // already delivered through other channels.
    expect(body.text).toBeUndefined();
  });

  it('POSTs on failed → metadata.agentStatus=error', async () => {
    createRunWith({});
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    } as Response);
    await notifyDelegationTerminal('run-1', 'failed', {
      store,
      deps: { fetch: fetchFn as unknown as typeof fetch },
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string);
    expect(body.metadata.agentStatus).toBe('error');
    expect(body.metadata.terminal).toBe(true);
  });

  it('tolerates 404 (old receiver) — returns true', async () => {
    createRunWith({});
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => '',
    } as Response);
    const ok = await notifyDelegationTerminal('run-1', 'completed', {
      store,
      deps: { fetch: fetchFn as unknown as typeof fetch },
    });
    expect(ok).toBe(true);
  });

  it('returns false on non-404 non-2xx', async () => {
    createRunWith({});
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'boom',
    } as Response);
    const ok = await notifyDelegationTerminal('run-1', 'completed', {
      store,
      deps: { fetch: fetchFn as unknown as typeof fetch },
    });
    expect(ok).toBe(false);
  });

  it('returns false on fetch reject (does not throw)', async () => {
    createRunWith({});
    const fetchFn = vi
      .fn()
      .mockRejectedValue(new Error('connect ECONNREFUSED'));
    const ok = await notifyDelegationTerminal('run-1', 'completed', {
      store,
      deps: { fetch: fetchFn as unknown as typeof fetch },
    });
    expect(ok).toBe(false);
  });
});
