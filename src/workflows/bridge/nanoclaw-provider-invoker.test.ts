// ─── Phase 2.5b — nanoclaw-provider-invoker tests ───
//
// Coverage:
//   - happy path: WorkflowRunRow → group lookup → runContainer call → result
//   - throws when run not in store
//   - throws when run has no chat_jid
//   - throws when chat_jid has no registered group
//   - throws when container returns status:error (preserves error message)
//   - returns empty string when container returns null result
//   - propagates newSessionId
//   - honors freshContext: clears sessionId
//   - threads requestingUserId from row.user_id
//   - fail-fast on already-aborted signal (no spawn)
//   - AbortSignal mid-flight: forwards SIGTERM to spawned ChildProcess
//   - cleanup: abort listener removed after run completes

import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _closeDatabase, _initTestDatabase, _getDb } from '../../db.js';
import { SqliteWorkflowStore } from '../store/sqlite-workflow-store.js';
import type {
  ContainerInput,
  ContainerOutput,
} from '../../container-runner.js';
import type { RegisteredGroup } from '../../types.js';
import { createNanoClawProviderInvoker } from './nanoclaw-provider-invoker.js';

/** Minimal ChildProcess stub: tracks kill calls and exposes pid. */
class FakeChildProc extends EventEmitter {
  pid: number;
  killed = false;
  killSignals: string[] = [];
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
  kill(sig: NodeJS.Signals | number): boolean {
    this.killSignals.push(String(sig));
    this.killed = true;
    return true;
  }
}

const SAMPLE_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: '@delegate',
  added_at: '2026-05-13T00:00:00Z',
  isMain: true,
};

function makeOpts(
  over: Partial<
    Parameters<ReturnType<typeof createNanoClawProviderInvoker>>[0]
  > = {},
) {
  return {
    workflowRunId: 'run-1',
    nodeId: 'n-1',
    provider: 'nanoclaw' as const,
    prompt: 'hello',
    artifactsDir: '/tmp/arts',
    ...over,
  };
}

describe('nanoclaw-provider-invoker — happy path', () => {
  let store: SqliteWorkflowStore;

  beforeEach(() => {
    _initTestDatabase();
    store = new SqliteWorkflowStore(_getDb());
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('reads run, resolves group, calls runContainer, returns mapped result', async () => {
    store.createRun({
      id: 'run-1',
      workflow_name: 'wf',
      user_message: 'go',
      chat_jid: 'delegate:main',
      user_id: 'u-1',
    });
    const runContainer = vi.fn(
      async (
        _g: RegisteredGroup,
        _i: ContainerInput,
        _onProc: (p: any, n: string) => void,
      ): Promise<ContainerOutput> => ({
        status: 'success',
        result: 'OK',
        newSessionId: 'sess-9',
      }),
    );
    const resolveGroup = vi.fn(() => SAMPLE_GROUP);

    const invoker = createNanoClawProviderInvoker({
      store,
      runContainer:
        runContainer as unknown as typeof import('../../container-runner.js').runContainerAgent,
      resolveGroup,
    });
    const result = await invoker(makeOpts({ model: 'claude-sonnet-4-6' }));

    expect(result.output).toBe('OK');
    expect(result.sessionId).toBe('sess-9');
    expect(resolveGroup).toHaveBeenCalledWith('delegate:main');
    const [, input] = runContainer.mock.calls[0]!;
    expect(input.prompt).toBe('hello');
    expect(input.chatJid).toBe('delegate:main');
    expect(input.groupFolder).toBe('main');
    expect(input.isMain).toBe(true);
    expect(input.requestingUserId).toBe('u-1');
    expect(input.assistantName).toBe('claude-sonnet-4-6');
  });

  it('returns empty string when container returns null result', async () => {
    store.createRun({
      id: 'run-1',
      workflow_name: 'wf',
      user_message: 'go',
      chat_jid: 'delegate:main',
    });
    const runContainer = vi.fn(
      async (): Promise<ContainerOutput> => ({
        status: 'success',
        result: null,
      }),
    );
    const invoker = createNanoClawProviderInvoker({
      store,
      runContainer:
        runContainer as unknown as typeof import('../../container-runner.js').runContainerAgent,
      resolveGroup: () => SAMPLE_GROUP,
    });
    const r = await invoker(makeOpts());
    expect(r.output).toBe('');
    expect(r.sessionId).toBeUndefined();
  });

  it('honors freshContext: drops sessionId in ContainerInput', async () => {
    store.createRun({
      id: 'run-1',
      workflow_name: 'wf',
      user_message: 'go',
      chat_jid: 'delegate:main',
    });
    const runContainer = vi.fn(
      async (): Promise<ContainerOutput> => ({
        status: 'success',
        result: 'x',
      }),
    );
    const invoker = createNanoClawProviderInvoker({
      store,
      runContainer:
        runContainer as unknown as typeof import('../../container-runner.js').runContainerAgent,
      resolveGroup: () => SAMPLE_GROUP,
    });
    await invoker(makeOpts({ sessionId: 'prior', freshContext: true }));
    const [, input] = runContainer.mock.calls[0]!;
    expect(input.sessionId).toBeUndefined();
  });

  it('preserves sessionId when freshContext is false/undefined', async () => {
    store.createRun({
      id: 'run-1',
      workflow_name: 'wf',
      user_message: 'go',
      chat_jid: 'delegate:main',
    });
    const runContainer = vi.fn(
      async (): Promise<ContainerOutput> => ({
        status: 'success',
        result: 'x',
      }),
    );
    const invoker = createNanoClawProviderInvoker({
      store,
      runContainer:
        runContainer as unknown as typeof import('../../container-runner.js').runContainerAgent,
      resolveGroup: () => SAMPLE_GROUP,
    });
    await invoker(makeOpts({ sessionId: 'sess-prev' }));
    const [, input] = runContainer.mock.calls[0]!;
    expect(input.sessionId).toBe('sess-prev');
  });
});

describe('nanoclaw-provider-invoker — error paths', () => {
  let store: SqliteWorkflowStore;

  beforeEach(() => {
    _initTestDatabase();
    store = new SqliteWorkflowStore(_getDb());
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('throws when workflow run not in store', async () => {
    const invoker = createNanoClawProviderInvoker({
      store,
      runContainer:
        vi.fn() as unknown as typeof import('../../container-runner.js').runContainerAgent,
      resolveGroup: () => SAMPLE_GROUP,
    });
    await expect(invoker(makeOpts())).rejects.toThrow(/run run-1 not found/i);
  });

  it('throws when run has no chat_jid', async () => {
    store.createRun({
      id: 'run-1',
      workflow_name: 'wf',
      user_message: 'go',
      chat_jid: null,
    });
    const invoker = createNanoClawProviderInvoker({
      store,
      runContainer:
        vi.fn() as unknown as typeof import('../../container-runner.js').runContainerAgent,
      resolveGroup: () => SAMPLE_GROUP,
    });
    await expect(invoker(makeOpts())).rejects.toThrow(/no chat_jid/);
  });

  it('throws when no registered group for chat_jid', async () => {
    store.createRun({
      id: 'run-1',
      workflow_name: 'wf',
      user_message: 'go',
      chat_jid: 'delegate:rogue',
    });
    const invoker = createNanoClawProviderInvoker({
      store,
      runContainer:
        vi.fn() as unknown as typeof import('../../container-runner.js').runContainerAgent,
      resolveGroup: () => null,
    });
    await expect(invoker(makeOpts())).rejects.toThrow(
      /no registered group for chat_jid/,
    );
  });

  it('throws when container returns status:error with message', async () => {
    store.createRun({
      id: 'run-1',
      workflow_name: 'wf',
      user_message: 'go',
      chat_jid: 'delegate:main',
    });
    const runContainer = vi.fn(
      async (): Promise<ContainerOutput> => ({
        status: 'error',
        result: null,
        error: 'container_oom',
      }),
    );
    const invoker = createNanoClawProviderInvoker({
      store,
      runContainer:
        runContainer as unknown as typeof import('../../container-runner.js').runContainerAgent,
      resolveGroup: () => SAMPLE_GROUP,
    });
    await expect(invoker(makeOpts())).rejects.toThrow(/container_oom/);
  });

  it('throws with generic message when container error has no message', async () => {
    store.createRun({
      id: 'run-1',
      workflow_name: 'wf',
      user_message: 'go',
      chat_jid: 'delegate:main',
    });
    const runContainer = vi.fn(
      async (): Promise<ContainerOutput> => ({
        status: 'error',
        result: null,
      }),
    );
    const invoker = createNanoClawProviderInvoker({
      store,
      runContainer:
        runContainer as unknown as typeof import('../../container-runner.js').runContainerAgent,
      resolveGroup: () => SAMPLE_GROUP,
    });
    await expect(invoker(makeOpts())).rejects.toThrow(
      /container returned error/i,
    );
  });
});

describe('nanoclaw-provider-invoker — abort signal', () => {
  let store: SqliteWorkflowStore;

  beforeEach(() => {
    _initTestDatabase();
    store = new SqliteWorkflowStore(_getDb());
    store.createRun({
      id: 'run-1',
      workflow_name: 'wf',
      user_message: 'go',
      chat_jid: 'delegate:main',
    });
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('fail-fast when signal is already aborted (does not spawn)', async () => {
    const controller = new AbortController();
    controller.abort();
    const runContainer = vi.fn();
    const invoker = createNanoClawProviderInvoker({
      store,
      runContainer:
        runContainer as unknown as typeof import('../../container-runner.js').runContainerAgent,
      resolveGroup: () => SAMPLE_GROUP,
    });
    await expect(
      invoker(makeOpts({ signal: controller.signal })),
    ).rejects.toThrow(/aborted before container spawn/);
    expect(runContainer).not.toHaveBeenCalled();
  });

  it('forwards SIGTERM to the spawned container on mid-flight abort', async () => {
    const fake = new FakeChildProc(99999);
    let onProcHook: ((p: any, n: string) => void) | null = null;
    let resolveContainer: (v: ContainerOutput) => void;
    const containerPromise = new Promise<ContainerOutput>((res) => {
      resolveContainer = res;
    });
    const runContainer = vi.fn(
      async (_g: RegisteredGroup, _i: ContainerInput, onProc) => {
        onProcHook = onProc;
        onProc(fake as unknown as Parameters<typeof onProc>[0], 'cname');
        return containerPromise;
      },
    );

    const controller = new AbortController();
    const invoker = createNanoClawProviderInvoker({
      store,
      runContainer:
        runContainer as unknown as typeof import('../../container-runner.js').runContainerAgent,
      resolveGroup: () => SAMPLE_GROUP,
    });
    const invokePromise = invoker(makeOpts({ signal: controller.signal }));

    // Wait a microtask so onProc has fired and the signal listener is registered.
    await new Promise((r) => setImmediate(r));
    expect(onProcHook).not.toBeNull();

    controller.abort();
    // Abort listener should have fired SIGTERM.
    expect(fake.killSignals).toContain('SIGTERM');

    // Resolve so the invoke completes naturally.
    resolveContainer!({ status: 'success', result: 'partial' });
    const r = await invokePromise;
    expect(r.output).toBe('partial');
  });

  it('removes abort listener after run completes', async () => {
    const controller = new AbortController();
    const fake = new FakeChildProc(11111);
    const runContainer = vi.fn(async (_g, _i, onProc) => {
      onProc(fake as unknown as Parameters<typeof onProc>[0], 'cname');
      return { status: 'success' as const, result: 'done' };
    });
    const invoker = createNanoClawProviderInvoker({
      store,
      runContainer:
        runContainer as unknown as typeof import('../../container-runner.js').runContainerAgent,
      resolveGroup: () => SAMPLE_GROUP,
    });
    await invoker(makeOpts({ signal: controller.signal }));

    // Post-completion: aborting must NOT kill the (already-completed) fake.
    const killCountBefore = fake.killSignals.length;
    controller.abort();
    expect(fake.killSignals.length).toBe(killCountBefore);
  });
});
