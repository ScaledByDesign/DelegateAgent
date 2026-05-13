// Phase 4.5 — on_reject prompt-replay loop.
//
// AC: when an approval node is rejected AND the node's `approval.on_reject`
// is configured AND the per-node attempt counter is below `on_reject.max_attempts`,
// the executor re-runs the approval node's UPSTREAM prompt-producing predecessor
// with `$REJECTION_REASON` populated, then re-opens the gate. When the budget
// is exhausted, the run terminal-cancels with `metadata.on_reject_exhausted`.
//
// Limitations (v1, documented in dag-executor.ts at the on_reject branch):
//   - Approval node MUST have exactly one upstream (depends_on.length === 1).
//   - Upstream must be a prompt / command / loop node (bash/script don't read vars).
//   - Workflow author's responsibility: upstream prompt must reference
//     `$REJECTION_REASON` for the rejection feedback to influence the rerun.

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
  if (!r.success) throw new Error(JSON.stringify(r.error.issues));
  return r.data;
}

beforeEach(() => {
  db = new Database(':memory:');
  createWorkflowSchema(db);
  store = new SqliteWorkflowStore(db);
  emitter = createWorkflowEventEmitter(store);
  artifactsRoot = mkdtempSync(join(tmpdir(), 'on-reject-'));
  _resetProviderInvoker();
});

afterEach(() => {
  db.close();
  rmSync(artifactsRoot, { recursive: true, force: true });
  _resetProviderInvoker();
  vi.restoreAllMocks();
});

// ─── happy path: reject + on_reject re-runs upstream ──────────────────────

describe('on_reject — upstream re-runs with $REJECTION_REASON', () => {
  it('first reject re-runs the upstream prompt node + re-pauses approval', async () => {
    const workflow = parseWorkflow({
      name: 'oreject-rerun',
      description: 'on_reject retry',
      nodes: [
        // Upstream prompt reads $REJECTION_REASON — its prompt template will
        // be substituted on each iteration so the LLM sees the prior reject.
        {
          id: 'draft',
          prompt: 'draft something; prior_reason: "$REJECTION_REASON"',
        },
        {
          id: 'approve',
          depends_on: ['draft'],
          approval: {
            message: 'Approve the draft?',
            on_reject: { prompt: 'try harder', max_attempts: 3 },
          },
        },
      ],
    });
    const { id: runId } = makeRun('oreject-rerun');

    const prompts: string[] = [];
    setProviderInvoker(async (opts) => {
      prompts.push(opts.prompt);
      return { output: `draft v${prompts.length}` };
    });

    // First execution → upstream runs, gate opens.
    const r1 = await executeWorkflow(runId, workflow, { store, emitter });
    expect(r1.finalStatus).toBe('paused');
    expect(prompts).toHaveLength(1);
    // First iteration sees empty REJECTION_REASON.
    expect(prompts[0]).toBe('draft something; prior_reason: ""');

    // Reject once → on_reject re-runs upstream + re-paused gate.
    const r2 = await resumeWorkflow(
      runId,
      workflow,
      { store, emitter },
      {
        decision: 'reject',
        reason: 'too vague',
      },
    );
    expect(r2.finalStatus).toBe('paused');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toBe('draft something; prior_reason: "too vague"');

    const run = store.getRun(runId)!;
    expect(run.status).toBe('paused');
    expect(
      (run.metadata.approval_attempts as Record<string, number>).approve,
    ).toBe(1);
    // Approval node is back in 'pending' state — re-paused via fresh gate
    // open. Approval context refreshed.
    expect((run.metadata.approval as { nodeId: string }).nodeId).toBe(
      'approve',
    );
  });

  it('approve after on_reject path completes the run cleanly', async () => {
    const workflow = parseWorkflow({
      name: 'oreject-approve-after',
      description: 'approve after rejection',
      nodes: [
        { id: 'draft', prompt: 'draft; reason: $REJECTION_REASON' },
        {
          id: 'approve',
          depends_on: ['draft'],
          approval: {
            message: 'Approve?',
            on_reject: { prompt: 'revise', max_attempts: 3 },
          },
        },
        { id: 'ship', depends_on: ['approve'], bash: 'echo shipped' },
      ],
    });
    const { id: runId } = makeRun('oreject-approve-after');

    setProviderInvoker(async () => ({ output: 'a draft' }));

    await executeWorkflow(runId, workflow, { store, emitter });
    await resumeWorkflow(
      runId,
      workflow,
      { store, emitter },
      {
        decision: 'reject',
        reason: 'first take rough',
      },
    );
    const r3 = await resumeWorkflow(
      runId,
      workflow,
      { store, emitter },
      {
        decision: 'approve',
      },
    );

    expect(r3.finalStatus).toBe('completed');
    const nodes = store.listNodesForRun(runId);
    const ship = nodes.find((n) => n.node_id === 'ship')!;
    expect(ship.state).toBe('completed');
    expect(ship.output).toMatch(/shipped/);
  });
});

// ─── budget exhaustion ────────────────────────────────────────────────────

describe('on_reject — max_attempts terminal-cancels', () => {
  it('cancels run when rejection budget is exhausted', async () => {
    const workflow = parseWorkflow({
      name: 'oreject-exhaust',
      description: 'exhaust attempts',
      nodes: [
        { id: 'draft', prompt: 'draft attempt' },
        {
          id: 'approve',
          depends_on: ['draft'],
          approval: {
            message: 'Approve?',
            on_reject: { prompt: 'retry', max_attempts: 2 },
          },
        },
      ],
    });
    const { id: runId } = makeRun('oreject-exhaust');

    setProviderInvoker(async () => ({ output: 'a draft' }));

    await executeWorkflow(runId, workflow, { store, emitter });
    // Reject 1 → re-runs (attempts=1), pause again.
    const r1 = await resumeWorkflow(
      runId,
      workflow,
      { store, emitter },
      {
        decision: 'reject',
        reason: 'no',
      },
    );
    expect(r1.finalStatus).toBe('paused');
    // Reject 2 → re-runs (attempts=2), pause again.
    const r2 = await resumeWorkflow(
      runId,
      workflow,
      { store, emitter },
      {
        decision: 'reject',
        reason: 'still no',
      },
    );
    expect(r2.finalStatus).toBe('paused');
    // Reject 3 → budget exhausted, terminal-cancels.
    const r3 = await resumeWorkflow(
      runId,
      workflow,
      { store, emitter },
      {
        decision: 'reject',
        reason: 'final no',
      },
    );
    expect(r3.finalStatus).toBe('cancelled');

    const run = store.getRun(runId)!;
    expect(run.status).toBe('cancelled');
    expect(run.metadata.rejection_reason).toBe('final no');
    expect(run.metadata.on_reject_exhausted).toBe(true);
    expect(run.metadata.on_reject_attempts).toBe(2);
  });
});

// ─── fallback: no on_reject → existing cancel behavior preserved ──────────

describe('reject without on_reject — existing cancel preserved', () => {
  it('reject + no on_reject cancels immediately (Phase 4 behavior)', async () => {
    const workflow = parseWorkflow({
      name: 'plain-reject',
      description: 'no on_reject',
      nodes: [
        { id: 'draft', prompt: 'draft' },
        {
          id: 'approve',
          depends_on: ['draft'],
          approval: { message: 'Approve?' },
        },
      ],
    });
    const { id: runId } = makeRun('plain-reject');

    let calls = 0;
    setProviderInvoker(async () => {
      calls++;
      return { output: 'a draft' };
    });

    await executeWorkflow(runId, workflow, { store, emitter });
    expect(calls).toBe(1);

    const r2 = await resumeWorkflow(
      runId,
      workflow,
      { store, emitter },
      {
        decision: 'reject',
        reason: 'nope',
      },
    );
    expect(r2.finalStatus).toBe('cancelled');
    // Upstream NOT re-run.
    expect(calls).toBe(1);

    const run = store.getRun(runId)!;
    expect(run.metadata.rejection_reason).toBe('nope');
    expect(run.metadata.on_reject_exhausted).toBeUndefined();
  });
});

// ─── fallback: approval node without single upstream → cancel ─────────────

describe('on_reject — degenerate upstream falls back to cancel', () => {
  it('approval node with zero upstreams cancels (no node to re-run)', async () => {
    const workflow = parseWorkflow({
      name: 'oreject-noup',
      description: 'no upstream',
      nodes: [
        {
          id: 'approve',
          approval: {
            message: 'Approve?',
            on_reject: { prompt: 'try again', max_attempts: 5 },
          },
        },
      ],
    });
    const { id: runId } = makeRun('oreject-noup');

    await executeWorkflow(runId, workflow, { store, emitter });
    const r = await resumeWorkflow(
      runId,
      workflow,
      { store, emitter },
      {
        decision: 'reject',
        reason: 'orphan reject',
      },
    );
    expect(r.finalStatus).toBe('cancelled');
  });

  it('approval node with bash upstream cancels (bash cannot use REJECTION_REASON)', async () => {
    const workflow = parseWorkflow({
      name: 'oreject-bashup',
      description: 'bash upstream',
      nodes: [
        { id: 'prep', bash: "printf 'data'" },
        {
          id: 'approve',
          depends_on: ['prep'],
          approval: {
            message: 'Approve?',
            on_reject: { prompt: 'redo prep', max_attempts: 3 },
          },
        },
      ],
    });
    const { id: runId } = makeRun('oreject-bashup');

    await executeWorkflow(runId, workflow, { store, emitter });
    const r = await resumeWorkflow(
      runId,
      workflow,
      { store, emitter },
      {
        decision: 'reject',
        reason: 'data is wrong',
      },
    );
    // bash upstream is not eligible for on_reject re-run → cancel.
    expect(r.finalStatus).toBe('cancelled');
  });
});

// ─── REJECTION_REASON variable correctly threaded ─────────────────────────

describe('REJECTION_REASON variable plumbing', () => {
  it('upstream sees REJECTION_REASON via $REJECTION_REASON substitution', async () => {
    const workflow = parseWorkflow({
      name: 'oreject-var',
      description: 'rejection var',
      nodes: [
        { id: 'gen', prompt: '<r>$REJECTION_REASON</r>' },
        {
          id: 'approve',
          depends_on: ['gen'],
          approval: {
            message: 'Approve?',
            on_reject: { prompt: 'revise', max_attempts: 3 },
          },
        },
      ],
    });
    const { id: runId } = makeRun('oreject-var');

    const prompts: string[] = [];
    setProviderInvoker(async (opts) => {
      prompts.push(opts.prompt);
      return { output: 'output' };
    });

    await executeWorkflow(runId, workflow, { store, emitter });
    expect(prompts[0]).toBe('<r></r>');

    await resumeWorkflow(
      runId,
      workflow,
      { store, emitter },
      {
        decision: 'reject',
        reason: 'because reasons',
      },
    );
    expect(prompts[1]).toBe('<r>because reasons</r>');

    await resumeWorkflow(
      runId,
      workflow,
      { store, emitter },
      {
        decision: 'reject',
        reason: 'more reasons',
      },
    );
    expect(prompts[2]).toBe('<r>more reasons</r>');
  });
});
