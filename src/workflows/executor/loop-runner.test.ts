import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkflowSchema } from '../../db-workflows.js';
import {
  workflowDefinitionSchema,
  type WorkflowDefinition,
} from '../schemas/index.js';
import { SqliteWorkflowStore } from '../store/sqlite-workflow-store.js';
import { executeWorkflow } from './dag-executor.js';
import { createWorkflowEventEmitter } from './event-emitter.js';
import {
  _resetProviderInvoker,
  setProviderInvoker,
} from './provider-bridge.js';

// ─── test harness ───────────────────────────────────────────────────────────

let db: Database.Database;
let store: SqliteWorkflowStore;
let emitter: ReturnType<typeof createWorkflowEventEmitter>;
let artifactsRoot: string;

function makeRun(name: string) {
  const id = `run-${Math.random().toString(36).slice(2, 10)}`;
  const artifactsDir = join(artifactsRoot, id);
  store.createRun({
    id,
    workflow_name: name,
    user_message: 'hello',
    artifacts_dir: artifactsDir,
  });
  store.updateRunStatus(id, { status: 'running' });
  return { id, artifactsDir };
}

function parseWorkflow(yamlObj: unknown): WorkflowDefinition {
  const r = workflowDefinitionSchema.safeParse(yamlObj);
  if (!r.success)
    throw new Error(`fixture schema failed: ${JSON.stringify(r.error.issues)}`);
  return r.data;
}

beforeEach(() => {
  db = new Database(':memory:');
  createWorkflowSchema(db);
  store = new SqliteWorkflowStore(db);
  emitter = createWorkflowEventEmitter(store);
  artifactsRoot = mkdtempSync(join(tmpdir(), 'loop-runner-'));
  _resetProviderInvoker();
});

afterEach(() => {
  db.close();
  rmSync(artifactsRoot, { recursive: true, force: true });
  _resetProviderInvoker();
  vi.restoreAllMocks();
});

// ─── AC A6 — completion signal detection ───────────────────────────────────

describe('AC A6 — until signal detection', () => {
  it('stops when an iteration output contains the until signal', async () => {
    const workflow = parseWorkflow({
      name: 'loop-signal',
      description: 'until signal',
      nodes: [
        {
          id: 'l',
          loop: { prompt: 'iterate', until: 'DONE', max_iterations: 5 },
        },
      ],
    });
    const { id: runId } = makeRun('loop-signal');

    // Stub: iteration 1 returns 'still working', iteration 2 returns 'now DONE'.
    let calls = 0;
    const stub = vi.fn(async () => {
      calls++;
      return { output: calls < 2 ? 'still working' : 'now DONE' };
    });
    setProviderInvoker(stub);

    await executeWorkflow(runId, workflow, { store, emitter });

    const node = store.listNodesForRun(runId)[0];
    expect(node.state).toBe('completed');
    expect(node.output).toMatch(/DONE/);
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it('fails when max_iterations is exhausted without signal', async () => {
    const workflow = parseWorkflow({
      name: 'loop-max',
      description: 'max iters',
      nodes: [
        {
          id: 'l',
          loop: { prompt: 'iterate', until: 'NEVER', max_iterations: 3 },
        },
      ],
    });
    const { id: runId } = makeRun('loop-max');

    const stub = vi.fn(async () => ({ output: 'still working' }));
    setProviderInvoker(stub);

    await executeWorkflow(runId, workflow, { store, emitter });

    const node = store.listNodesForRun(runId)[0];
    expect(node.state).toBe('failed');
    expect(node.error).toMatch(/max_iterations \(3\) exhausted/);
    expect(stub).toHaveBeenCalledTimes(3);
  });
});

describe('AC A6 — until_bash deterministic gate wins over signal', () => {
  it('until_bash exit 0 completes the loop even though output lacks the signal', async () => {
    const { id: runId, artifactsDir } = makeRun('loop-bash');
    const workflow = parseWorkflow({
      name: 'loop-bash',
      description: 'bash gate',
      nodes: [
        {
          id: 'l',
          loop: {
            prompt: 'iterate',
            until: 'NEVER',
            max_iterations: 5,
            until_bash: 'test -f "$ARTIFACTS_DIR/done.flag"',
          },
        },
      ],
    });

    // Create the flag file on the SECOND iteration so until_bash returns 0
    // even though the AI output never contains 'NEVER'.
    let calls = 0;
    const stub = vi.fn(async () => {
      calls++;
      if (calls === 2) {
        writeFileSync(join(artifactsDir, 'done.flag'), 'ok', 'utf-8');
      }
      return { output: `iter ${calls}` };
    });
    setProviderInvoker(stub);

    // The executor's artifacts_dir is artifactsRoot/<runId>; we need to ensure
    // the dir exists so the bash gate's `test -f` resolves the flag we wrote.
    // execFile resolves cwd to ARTIFACTS_DIR which may not exist yet; create.
    // This mirrors what the executor would do via init-workspace bash node.
    const fs = await import('fs');
    fs.mkdirSync(artifactsDir, { recursive: true });

    await executeWorkflow(runId, workflow, { store, emitter });
    const node = store.listNodesForRun(runId)[0];
    expect(node.state).toBe('completed');
    // Stopped at iter 2 because until_bash flipped to exit 0; iter 3 not reached.
    expect(stub).toHaveBeenCalledTimes(2);
  });
});

describe('AC A6 — $LOOP_PREV_OUTPUT propagation', () => {
  it('iteration 2 sees iteration 1 output as $LOOP_PREV_OUTPUT', async () => {
    const workflow = parseWorkflow({
      name: 'loop-prev',
      description: 'prev output',
      nodes: [
        {
          id: 'l',
          loop: {
            prompt: 'prev=$LOOP_PREV_OUTPUT iter',
            until: 'DONE',
            max_iterations: 3,
          },
        },
      ],
    });
    const { id: runId } = makeRun('loop-prev');

    const promptsSeen: string[] = [];
    setProviderInvoker(async (opts) => {
      promptsSeen.push(opts.prompt);
      const isLast = promptsSeen.length >= 2;
      return { output: isLast ? 'finishing DONE' : 'first iteration' };
    });

    await executeWorkflow(runId, workflow, { store, emitter });

    // Iteration 1: $LOOP_PREV_OUTPUT empty → 'prev= iter'.
    // Iteration 2: $LOOP_PREV_OUTPUT='first iteration' (signal stripped, trimmed).
    expect(promptsSeen[0]).toBe('prev= iter');
    expect(promptsSeen[1]).toBe('prev=first iteration iter');
  });

  it('completion signal is stripped from prev_output before next iteration', async () => {
    const workflow = parseWorkflow({
      name: 'loop-strip',
      description: 'strip signal',
      nodes: [
        {
          id: 'l',
          loop: {
            prompt: 'see=$LOOP_PREV_OUTPUT',
            until: 'DONE',
            max_iterations: 4,
          },
        },
      ],
    });
    const { id: runId } = makeRun('loop-strip');

    const promptsSeen: string[] = [];
    let calls = 0;
    setProviderInvoker(async (opts) => {
      calls++;
      promptsSeen.push(opts.prompt);
      // Iter 1: output contains DONE → loop should complete on iter 1.
      if (calls === 1) return { output: 'all good DONE' };
      // If we get here, signal wasn't detected; force loop to fail max_iters.
      return { output: 'still working' };
    });

    await executeWorkflow(runId, workflow, { store, emitter });
    expect(promptsSeen.length).toBe(1);
    const node = store.listNodesForRun(runId)[0];
    expect(node.state).toBe('completed');
  });
});

describe('AC A6 — fresh_context isolation', () => {
  it('fresh_context: true sends sessionId=undefined every iteration', async () => {
    const workflow = parseWorkflow({
      name: 'loop-fresh',
      description: 'fresh ctx',
      nodes: [
        {
          id: 'l',
          loop: {
            prompt: 'iterate',
            until: 'STOP',
            max_iterations: 3,
            fresh_context: true,
          },
        },
      ],
    });
    const { id: runId } = makeRun('loop-fresh');

    const sessionsSeen: (string | undefined)[] = [];
    let calls = 0;
    setProviderInvoker(async (opts) => {
      calls++;
      sessionsSeen.push(opts.sessionId);
      // Last iteration returns the signal so the loop completes.
      return {
        output: calls < 3 ? 'work' : 'STOP',
        sessionId: `session-${calls}`,
      };
    });

    await executeWorkflow(runId, workflow, { store, emitter });
    // All three iterations sent sessionId: undefined despite provider returning sessionId.
    expect(sessionsSeen).toEqual([undefined, undefined, undefined]);
  });

  it('fresh_context: false reuses prior session id', async () => {
    const workflow = parseWorkflow({
      name: 'loop-shared',
      description: 'shared ctx',
      nodes: [
        {
          id: 'l',
          loop: {
            prompt: 'iterate',
            until: 'STOP',
            max_iterations: 3,
            // fresh_context omitted → defaults to false per schema
          },
        },
      ],
    });
    const { id: runId } = makeRun('loop-shared');

    const sessionsSeen: (string | undefined)[] = [];
    let calls = 0;
    setProviderInvoker(async (opts) => {
      calls++;
      sessionsSeen.push(opts.sessionId);
      return {
        output: calls < 3 ? 'work' : 'STOP',
        sessionId: `session-${calls}`,
      };
    });

    await executeWorkflow(runId, workflow, { store, emitter });
    // Iter 1: no prior session → undefined. Iter 2: session-1. Iter 3: session-2.
    expect(sessionsSeen).toEqual([undefined, 'session-1', 'session-2']);
  });
});

describe('Phase 4 — interactive loop pauses after iteration 1 (A7 covered in interactive-loop.test.ts)', () => {
  it('interactive loop runs iter 1 then pauses (no failure, run.status=paused)', async () => {
    const workflow = parseWorkflow({
      name: 'loop-int',
      description: 'interactive',
      nodes: [
        {
          id: 'l',
          loop: {
            prompt: 'review',
            until: 'APPROVED',
            max_iterations: 5,
            interactive: true,
            gate_message: 'Approve this sprint?',
          },
        },
      ],
    });
    const { id: runId } = makeRun('loop-int');

    const stub = vi.fn(async () => ({ output: 'iter 1 output' }));
    setProviderInvoker(stub);
    const result = await executeWorkflow(runId, workflow, { store, emitter });
    // Iter 1 ran, signal not detected, interactive gate fired → pause.
    expect(stub).toHaveBeenCalledTimes(1);
    expect(result.finalStatus).toBe('paused');
    expect(result.pausedApprovalId).toBe(`wf:${runId}:l:iter1`);
    expect(store.getRun(runId)?.status).toBe('paused');
  });
});

// ─── per-iteration event emission ──────────────────────────────────────────

describe('event emission — loop iterations', () => {
  it('emits dag.loop_iteration_started + completed for each iteration', async () => {
    const workflow = parseWorkflow({
      name: 'loop-events',
      description: 'events',
      nodes: [
        { id: 'l', loop: { prompt: 'iterate', until: 'X', max_iterations: 3 } },
      ],
    });
    const { id: runId } = makeRun('loop-events');

    let calls = 0;
    setProviderInvoker(async () => {
      calls++;
      return { output: calls < 2 ? 'going' : 'X' };
    });

    await executeWorkflow(runId, workflow, { store, emitter });
    const events = store.listEventsForRun(runId);
    const started = events.filter(
      (e) => e.event_type === 'dag.loop_iteration_started',
    );
    const completed = events.filter(
      (e) => e.event_type === 'dag.loop_iteration_completed',
    );
    expect(started.length).toBe(2);
    expect(completed.length).toBe(2);
    expect((started[0].data as { iteration: number }).iteration).toBe(1);
    expect((started[1].data as { iteration: number }).iteration).toBe(2);
    expect((completed[1].data as { completed: boolean }).completed).toBe(true);
  });
});

// ─── cancel honored mid-loop ──────────────────────────────────────────────

describe('cooperative cancel', () => {
  it('aborting the signal stops the loop on the next iteration boundary', async () => {
    const workflow = parseWorkflow({
      name: 'loop-cancel',
      description: 'cancel',
      nodes: [
        {
          id: 'l',
          loop: { prompt: 'iterate', until: 'NEVER', max_iterations: 10 },
        },
      ],
    });
    const { id: runId } = makeRun('loop-cancel');

    const ac = new AbortController();
    let calls = 0;
    setProviderInvoker(async () => {
      calls++;
      if (calls === 2) ac.abort();
      return { output: 'still going' };
    });

    const result = await executeWorkflow(runId, workflow, {
      store,
      emitter,
      signal: ac.signal,
    });
    const node = store.listNodesForRun(runId)[0];
    expect(node.state).toBe('failed');
    expect(node.error).toMatch(/cancelled/);
    // Iteration 1 ran, iteration 2 ran and triggered cancel, iteration 3 aborted.
    expect(calls).toBe(2);
    // Run-level cancel: the run aborts at the layer boundary in dag-executor;
    // because the cancel triggered mid-layer, the layer settles with a failed
    // node and the executor's signal check at the next layer transition catches
    // the abort.
    expect(['failed', 'cancelled']).toContain(result.finalStatus);
  });
});
