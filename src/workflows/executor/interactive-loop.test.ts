import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkflowSchema } from '../../db-workflows.js';
import {
  workflowDefinitionSchema,
  type WorkflowDefinition,
} from '../schemas/index.js';
import { SqliteWorkflowStore } from '../store/sqlite-workflow-store.js';
import { executeWorkflow, resumeWorkflow } from './dag-executor.js';
import { createWorkflowEventEmitter } from './event-emitter.js';
import {
  _resetProviderInvoker,
  setProviderInvoker,
} from './provider-bridge.js';

// ─── harness ────────────────────────────────────────────────────────────────

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
  return { id };
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
  artifactsRoot = mkdtempSync(join(tmpdir(), 'interactive-loop-'));
  _resetProviderInvoker();
});

afterEach(() => {
  db.close();
  rmSync(artifactsRoot, { recursive: true, force: true });
  _resetProviderInvoker();
  vi.restoreAllMocks();
});

// ─── AC A7 — interactive loop per-iteration approvalIds ─────────────────────

describe('AC A7 — interactive loop iteration approvalIds', () => {
  const workflowYaml = {
    name: 'a7-loop',
    description: 'interactive loop',
    nodes: [
      {
        id: 'review',
        loop: {
          prompt: 'iterate; user said: "$LOOP_USER_INPUT"',
          until: 'APPROVED',
          max_iterations: 5,
          interactive: true,
          gate_message: 'Approve this sprint?',
        },
      },
    ],
  };

  it('iter 1 and iter 2 produce DISTINCT approvalIds (wf:r:n:iter1 vs :iter2)', async () => {
    const workflow = parseWorkflow(workflowYaml);
    const { id: runId } = makeRun('a7-loop');

    const promptsSeen: string[] = [];
    setProviderInvoker(async (opts) => {
      promptsSeen.push(opts.prompt);
      return { output: 'still working' };
    });

    // First execute → iter 1 runs, pause with iter1 approvalId.
    const r1 = await executeWorkflow(runId, workflow, { store, emitter });
    expect(r1.finalStatus).toBe('paused');
    expect(r1.pausedApprovalId).toBe(`wf:${runId}:review:iter1`);

    // First approve → loop_state.loopUserInput captured for iter 2.
    const r2 = await resumeWorkflow(
      runId,
      workflow,
      { store, emitter },
      {
        decision: 'approve',
        response: 'looks good — proceed',
      },
    );
    expect(r2.finalStatus).toBe('paused');
    expect(r2.pausedApprovalId).toBe(`wf:${runId}:review:iter2`);

    // The two approvalIds MUST differ.
    expect(r1.pausedApprovalId).not.toBe(r2.pausedApprovalId);

    // Iter 2's prompt saw the captured user input via $LOOP_USER_INPUT.
    expect(promptsSeen).toHaveLength(2);
    expect(promptsSeen[0]).toContain('user said: ""');
    expect(promptsSeen[1]).toContain('user said: "looks good — proceed"');
  });

  it('loop completes when assistant emits the until signal after approval', async () => {
    const workflow = parseWorkflow(workflowYaml);
    const { id: runId } = makeRun('a7-loop-complete');

    let calls = 0;
    setProviderInvoker(async () => {
      calls++;
      return { output: calls >= 2 ? 'final answer APPROVED' : 'still working' };
    });

    // Iter 1 — pause.
    let result = await executeWorkflow(runId, workflow, { store, emitter });
    expect(result.finalStatus).toBe('paused');
    // Approve — iter 2 runs, output contains APPROVED → loop completes.
    result = await resumeWorkflow(
      runId,
      workflow,
      { store, emitter },
      {
        decision: 'approve',
        response: 'yes',
      },
    );
    expect(result.finalStatus).toBe('completed');
    expect(calls).toBe(2);

    // loop_state should be cleared after completion.
    const run = store.getRun(runId)!;
    const loopState = run.metadata.loop_state as
      | Record<string, unknown>
      | undefined;
    expect(loopState?.review).toBeUndefined();
  });

  it('iter 1 reject cancels the run; no further iteration runs', async () => {
    const workflow = parseWorkflow(workflowYaml);
    const { id: runId } = makeRun('a7-loop-reject');

    let calls = 0;
    setProviderInvoker(async () => {
      calls++;
      return { output: 'still working' };
    });
    await executeWorkflow(runId, workflow, { store, emitter });
    const result = await resumeWorkflow(
      runId,
      workflow,
      { store, emitter },
      {
        decision: 'reject',
        reason: 'not this approach',
      },
    );

    expect(result.finalStatus).toBe('cancelled');
    expect(calls).toBe(1); // only iter 1 invoked; iter 2 never started
  });
});

// ─── AC A7 — idempotency: distinct AgentApproval rows per iteration ───────

describe('AC A7 — DA-side idempotency: workflow_runs.metadata.loop_state per nodeId', () => {
  it('persists iter + prevOutput + sessionId across pause/resume', async () => {
    const workflow = parseWorkflow({
      name: 'a7-state',
      description: 'state persistence',
      nodes: [
        {
          id: 'review',
          loop: {
            prompt: 'iter $LOOP_PREV_OUTPUT',
            until: 'STOP',
            max_iterations: 5,
            interactive: true,
            gate_message: 'Approve?',
          },
        },
      ],
    });
    const { id: runId } = makeRun('a7-state');

    let calls = 0;
    setProviderInvoker(async () => {
      calls++;
      return { output: `iter${calls}-output`, sessionId: `session-${calls}` };
    });

    await executeWorkflow(runId, workflow, { store, emitter });

    // After iter 1 + pause, loop_state should reflect iter=1.
    let run = store.getRun(runId)!;
    let loopState = run.metadata.loop_state as Record<
      string,
      { iter: number; sessionId?: string; prevOutput: string }
    >;
    expect(loopState.review.iter).toBe(1);
    expect(loopState.review.sessionId).toBe('session-1');
    expect(loopState.review.prevOutput).toMatch(/iter1-output/);

    // Resume → iter 2 runs, pause again with iter=2.
    await resumeWorkflow(
      runId,
      workflow,
      { store, emitter },
      {
        decision: 'approve',
        response: 'continue',
      },
    );

    run = store.getRun(runId)!;
    loopState = run.metadata.loop_state as Record<
      string,
      { iter: number; sessionId?: string; prevOutput: string }
    >;
    expect(loopState.review.iter).toBe(2);
    expect(loopState.review.sessionId).toBe('session-2');
    expect(loopState.review.prevOutput).toMatch(/iter2-output/);
  });
});
