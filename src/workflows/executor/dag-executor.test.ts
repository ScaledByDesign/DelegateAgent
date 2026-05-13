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
import { ConcurrencyScanner } from './concurrency-scanner.js';
import {
  buildTopologicalLayers,
  checkTriggerRule,
  executeWorkflow,
} from './dag-executor.js';
import { evaluateCondition } from './condition-evaluator.js';
import { createWorkflowEventEmitter } from './event-emitter.js';
import {
  classifyError,
  substituteNodeOutputRefs,
  substituteWorkflowVariables,
} from './executor-shared.js';
import {
  _resetProviderInvoker,
  setProviderInvoker,
} from './provider-bridge.js';

// ─── test harness ───────────────────────────────────────────────────────────

let db: Database.Database;
let store: SqliteWorkflowStore;
let emitter: ReturnType<typeof createWorkflowEventEmitter>;
let artifactsRoot: string;

function makeRun(
  overrides: Partial<Parameters<SqliteWorkflowStore['createRun']>[0]> = {},
) {
  const id = overrides.id ?? `run-${Math.random().toString(36).slice(2, 10)}`;
  const artifactsDir = join(artifactsRoot, id);
  store.createRun({
    id,
    workflow_name: 'test-workflow',
    user_message: 'hello',
    artifacts_dir: artifactsDir,
    ...overrides,
  });
  // Promote to running so executeWorkflow accepts it.
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
  artifactsRoot = mkdtempSync(join(tmpdir(), 'dag-exec-'));
  _resetProviderInvoker();
});

afterEach(() => {
  db.close();
  rmSync(artifactsRoot, { recursive: true, force: true });
  _resetProviderInvoker();
  vi.restoreAllMocks();
});

// ─── helper utilities (sanity) ─────────────────────────────────────────────

describe('substituteWorkflowVariables', () => {
  it('expands documented vars', () => {
    const out = substituteWorkflowVariables(
      'id=$WORKFLOW_ID dir=$ARTIFACTS_DIR',
      {
        WORKFLOW_ID: 'r1',
        USER_MESSAGE: 'hi',
        ARTIFACTS_DIR: '/tmp/r1',
      },
    );
    expect(out).toBe('id=r1 dir=/tmp/r1');
  });

  it('leaves $PATH and unrelated env refs alone', () => {
    const out = substituteWorkflowVariables('echo $PATH $WORKFLOW_ID', {
      WORKFLOW_ID: 'r1',
      USER_MESSAGE: '',
      ARTIFACTS_DIR: '',
    });
    expect(out).toBe('echo $PATH r1');
  });

  it('respects word boundaries on $BASE_BRANCH vs $BASE_BRANCHED', () => {
    const out = substituteWorkflowVariables('a=$BASE_BRANCH b=$BASE_BRANCHED', {
      WORKFLOW_ID: '',
      USER_MESSAGE: '',
      ARTIFACTS_DIR: '',
      BASE_BRANCH: 'main',
    });
    expect(out).toBe('a=main b=$BASE_BRANCHED');
  });
});

describe('substituteNodeOutputRefs', () => {
  it('inlines plain output', () => {
    const refs = new Map([
      ['a', { state: 'completed', output: 'hello' } as const],
    ]);
    expect(substituteNodeOutputRefs('echo $a.output', refs)).toBe('echo hello');
  });

  it('dot-accesses JSON fields', () => {
    const refs = new Map([
      [
        'a',
        { state: 'completed', output: '{"flavor":"BUG","score":7}' } as const,
      ],
    ]);
    expect(
      substituteNodeOutputRefs('$a.output.flavor=$a.output.score', refs),
    ).toBe('BUG=7');
  });

  it('unknown nodes resolve to empty string', () => {
    expect(substituteNodeOutputRefs('x=[$missing.output]', new Map())).toBe(
      'x=[]',
    );
  });
});

describe('classifyError', () => {
  it('FATAL on auth pattern', () => {
    expect(classifyError(new Error('unauthorized: 401'))).toBe('FATAL');
    expect(classifyError(new Error('forbidden'))).toBe('FATAL');
    expect(classifyError(new Error('insufficient credits'))).toBe('FATAL');
  });

  it('TRANSIENT on subprocess exit + timeout', () => {
    expect(classifyError(new Error('command exited with code 1'))).toBe(
      'TRANSIENT',
    );
    expect(classifyError(new Error('ECONNRESET'))).toBe('TRANSIENT');
    expect(classifyError(new Error('timed out after 30s'))).toBe('TRANSIENT');
  });

  it('FATAL when both fatal and transient tokens collide (fatal precedence)', () => {
    expect(
      classifyError(new Error('unauthorized: process exited with code 1')),
    ).toBe('FATAL');
  });

  it('FATAL by default for unrecognized strings', () => {
    expect(classifyError(new Error('weird wibble'))).toBe('FATAL');
  });
});

// ─── condition-evaluator (when:) ────────────────────────────────────────────

describe('AC A4 — condition evaluator', () => {
  const refs = new Map([
    ['a', { state: 'completed', output: 'OK' } as const],
    [
      'b',
      { state: 'completed', output: '{"flavor":"BUG","score":85}' } as const,
    ],
  ]);

  it('==', () => {
    expect(evaluateCondition("$a.output == 'OK'", refs)).toEqual({
      result: true,
      parsed: true,
    });
    expect(evaluateCondition("$a.output == 'NOPE'", refs)).toEqual({
      result: false,
      parsed: true,
    });
  });

  it('!=', () => {
    expect(evaluateCondition("$a.output != 'NOPE'", refs)).toEqual({
      result: true,
      parsed: true,
    });
  });

  it('>= numeric', () => {
    expect(evaluateCondition("$b.output.score >= '80'", refs)).toEqual({
      result: true,
      parsed: true,
    });
    expect(evaluateCondition("$b.output.score >= '90'", refs)).toEqual({
      result: false,
      parsed: true,
    });
  });

  it('AND short-circuit', () => {
    expect(
      evaluateCondition("$a.output == 'OK' && $b.output.flavor == 'BUG'", refs),
    ).toEqual({ result: true, parsed: true });
    expect(
      evaluateCondition("$a.output == 'OK' && $b.output.flavor == 'OK'", refs),
    ).toEqual({ result: false, parsed: true });
  });

  it('OR short-circuit', () => {
    expect(
      evaluateCondition(
        "$a.output == 'NOPE' || $b.output.flavor == 'BUG'",
        refs,
      ),
    ).toEqual({ result: true, parsed: true });
  });

  it('JSON dot access', () => {
    expect(evaluateCondition("$b.output.flavor == 'BUG'", refs)).toEqual({
      result: true,
      parsed: true,
    });
  });

  it('fail-closed on malformed', () => {
    expect(evaluateCondition('not a valid expression', refs)).toEqual({
      result: false,
      parsed: false,
    });
  });
});

// ─── topological layering ──────────────────────────────────────────────────

describe('buildTopologicalLayers', () => {
  it('groups independent nodes', () => {
    const nodes = parseWorkflow({
      name: 'demo',
      description: 'd',
      nodes: [
        { id: 'a', prompt: 'x' },
        { id: 'b', prompt: 'y' },
        { id: 'c', depends_on: ['a', 'b'], prompt: 'z' },
      ],
    }).nodes;
    const layers = buildTopologicalLayers(nodes);
    expect(layers.length).toBe(2);
    expect(layers[0].map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect(layers[1].map((n) => n.id)).toEqual(['c']);
  });

  it('detects cycles', () => {
    expect(() =>
      buildTopologicalLayers([
        { id: 'a', depends_on: ['b'], prompt: 'x' } as never,
        { id: 'b', depends_on: ['a'], prompt: 'y' } as never,
      ]),
    ).toThrow(/cycle/);
  });
});

// ─── trigger rules (A3) ────────────────────────────────────────────────────

describe('AC A3 — checkTriggerRule', () => {
  const nodeDeps = (rule?: string) =>
    ({
      id: 'c',
      prompt: 'x',
      depends_on: ['a', 'b'],
      ...(rule ? { trigger_rule: rule } : {}),
    }) as never;

  it('all_success: runs only when all completed', () => {
    const states = new Map<string, 'completed' | 'failed' | 'skipped'>([
      ['a', 'completed'],
      ['b', 'completed'],
    ]);
    expect(checkTriggerRule(nodeDeps(), states)).toBe('run');
    states.set('b', 'failed');
    expect(checkTriggerRule(nodeDeps(), states)).toBe('skip');
  });

  it('one_success: runs if at least one completed', () => {
    const states = new Map<string, 'completed' | 'failed'>([
      ['a', 'completed'],
      ['b', 'failed'],
    ]);
    expect(checkTriggerRule(nodeDeps('one_success'), states)).toBe('run');
  });

  it('none_failed_min_one_success: skip on failed, run on completed+skipped', () => {
    const okSkipped = new Map<string, 'completed' | 'skipped'>([
      ['a', 'completed'],
      ['b', 'skipped'],
    ]);
    expect(
      checkTriggerRule(nodeDeps('none_failed_min_one_success'), okSkipped),
    ).toBe('run');

    const failedOne = new Map<string, 'completed' | 'failed'>([
      ['a', 'completed'],
      ['b', 'failed'],
    ]);
    expect(
      checkTriggerRule(nodeDeps('none_failed_min_one_success'), failedOne),
    ).toBe('skip');
  });

  it('all_done: runs regardless', () => {
    const states = new Map<string, 'completed' | 'failed'>([
      ['a', 'failed'],
      ['b', 'failed'],
    ]);
    expect(checkTriggerRule(nodeDeps('all_done'), states)).toBe('run');
  });
});

// ─── AC A2 — end-to-end DAG ordering + $a.output substitution ─────────────

describe('AC A2 — DAG ordering + variable substitution', () => {
  it("runs node a then b, with $a.output substituted into b's bash body", async () => {
    const workflow = parseWorkflow({
      name: 'a2',
      description: 'AC A2',
      nodes: [
        { id: 'a', bash: 'echo "HELLO"' },
        { id: 'b', depends_on: ['a'], bash: 'echo "got=$a.output"' },
      ],
    });
    const { id: runId } = makeRun({ workflow_name: 'a2' });

    const result = await executeWorkflow(runId, workflow, { store, emitter });
    expect(result.finalStatus).toBe('completed');

    const nodes = store.listNodesForRun(runId);
    const a = nodes.find((n) => n.node_id === 'a')!;
    const b = nodes.find((n) => n.node_id === 'b')!;
    expect(a.state).toBe('completed');
    expect(b.state).toBe('completed');
    expect(a.output?.trim()).toBe('HELLO');
    // The body went through substitution: b's stdout includes "got=HELLO".
    expect(b.output).toMatch(/got=HELLO/);
  });
});

// ─── AC A8 — bash stdout capture + timeout ────────────────────────────────

describe('AC A8 — bash node', () => {
  it('captures stdout literally', async () => {
    const workflow = parseWorkflow({
      name: 'a8',
      description: 'AC A8',
      nodes: [{ id: 'x', bash: 'printf "hello\\n"' }],
    });
    const { id: runId } = makeRun({ workflow_name: 'a8' });
    await executeWorkflow(runId, workflow, { store, emitter });
    const x = store.listNodesForRun(runId)[0];
    expect(x.state).toBe('completed');
    expect(x.output).toBe('hello\n');
  });

  it('times out long-running bash with TRANSIENT classification', async () => {
    const workflow = parseWorkflow({
      name: 'a8t',
      description: 'AC A8 timeout',
      nodes: [{ id: 'y', bash: 'sleep 5', timeout: 200 }],
    });
    const { id: runId } = makeRun({ workflow_name: 'a8t' });
    await executeWorkflow(runId, workflow, { store, emitter });
    const y = store.listNodesForRun(runId)[0];
    expect(y.state).toBe('failed');
    expect(y.error).toBeTruthy();
    expect(classifyError(y.error!)).toBe('TRANSIENT');
  });
});

// ─── AC A4 (executor) — when: skip ────────────────────────────────────────

describe('AC A4 (executor) — when: gate', () => {
  it('skips node b when $a.output != expected', async () => {
    // NOTE: condition-evaluator does strict string comparison; bash's `echo`
    // appends a trailing newline. Use `printf` (matching upstream Archon
    // convention) when the body is the entire $a.output for a when: check.
    const workflow = parseWorkflow({
      name: 'a4',
      description: 'AC A4',
      nodes: [
        { id: 'a', bash: "printf 'OK'" },
        {
          id: 'b',
          depends_on: ['a'],
          when: "$a.output == 'NOPE'",
          bash: 'echo "should-not-run"',
        },
        {
          id: 'c',
          depends_on: ['a'],
          when: "$a.output == 'OK'",
          bash: 'echo "ran"',
        },
      ],
    });
    const { id: runId } = makeRun({ workflow_name: 'a4' });
    await executeWorkflow(runId, workflow, { store, emitter });
    const nodes = store.listNodesForRun(runId);
    const map = new Map(nodes.map((n) => [n.node_id, n] as const));
    expect(map.get('a')!.state).toBe('completed');
    expect(map.get('b')!.state).toBe('skipped');
    expect(map.get('c')!.state).toBe('completed');
    expect(map.get('c')!.output).toMatch(/ran/);
  });
});

// ─── AC A3 (executor) — trigger rule cascade ──────────────────────────────

describe('AC A3 (executor) — trigger rule cascade', () => {
  it('skips downstream all_success node when one parent fails', async () => {
    const workflow = parseWorkflow({
      name: 'a3',
      description: 'AC A3',
      nodes: [
        { id: 'a', bash: 'echo ok' },
        { id: 'b', bash: 'exit 1' },
        { id: 'c', depends_on: ['a', 'b'], bash: 'echo c' }, // all_success default
      ],
    });
    const { id: runId } = makeRun({ workflow_name: 'a3' });
    const result = await executeWorkflow(runId, workflow, { store, emitter });
    const map = new Map(
      store.listNodesForRun(runId).map((n) => [n.node_id, n.state] as const),
    );
    expect(map.get('a')).toBe('completed');
    expect(map.get('b')).toBe('failed');
    expect(map.get('c')).toBe('skipped');
    // Run-level: one node failed → run.status='failed' (Phase 3 bugfix).
    expect(result.finalStatus).toBe('failed');
    expect(result.failedNodes).toContain('b');
    expect(store.getRun(runId)?.status).toBe('failed');
  });

  it('runs downstream all_done node even when parents fail', async () => {
    const workflow = parseWorkflow({
      name: 'a3d',
      description: 'AC A3 all_done',
      nodes: [
        { id: 'a', bash: 'exit 1' },
        {
          id: 'b',
          depends_on: ['a'],
          trigger_rule: 'all_done',
          bash: 'echo b',
        },
      ],
    });
    const { id: runId } = makeRun({ workflow_name: 'a3d' });
    await executeWorkflow(runId, workflow, { store, emitter });
    const map = new Map(
      store.listNodesForRun(runId).map((n) => [n.node_id, n.state] as const),
    );
    expect(map.get('a')).toBe('failed');
    expect(map.get('b')).toBe('completed');
  });
});

// ─── AC A16 — concurrency cap ──────────────────────────────────────────────

describe('AC A16 — concurrency cap (cap=4 with 10 launches)', () => {
  it('claimRun caps simultaneous runs per chat_jid', async () => {
    // Launch 10 pending runs for the same jid; cap=4. Then run a scanner
    // tick. Expect 4 claimed (running), 6 still pending.
    const workflow = parseWorkflow({
      name: 'a16',
      description: 'AC A16',
      nodes: [
        // Loose work so nothing finishes during the scanner tick — we want
        // to measure "how many are RUNNING at any sampled moment".
        { id: 'sleep', bash: 'sleep 0.5' },
      ],
    });

    const jid = 'cap-test@s.whatsapp.net';
    for (let i = 0; i < 10; i++) {
      store.createRun({
        id: `cap-${i}`,
        workflow_name: 'a16',
        user_message: 'x',
        chat_jid: jid,
        artifacts_dir: join(artifactsRoot, `cap-${i}`),
      });
    }
    const scanner = new ConcurrencyScanner({
      store,
      resolveWorkflow: () => workflow,
      executorDeps: { emitter },
      getCap: () => 4,
    });
    const dispatched = await scanner.scanOnce();
    expect(dispatched.length).toBe(4);

    // Sample state immediately after claim (the dispatches are async; the
    // sleep ensures they're still in 'running' here).
    const running = store
      .listRunsByStatus('running')
      .filter((r) => r.chat_jid === jid);
    const pending = store
      .listRunsByStatus('pending')
      .filter((r) => r.chat_jid === jid);
    expect(running.length).toBe(4);
    expect(pending.length).toBe(6);

    // Drain the executor promises so afterEach cleanup is clean.
    await new Promise((r) => setTimeout(r, 800));
  });

  it('lowering cap to 2 results in 2 running, 8 pending', async () => {
    const workflow = parseWorkflow({
      name: 'a16-2',
      description: 'AC A16 cap=2',
      nodes: [{ id: 'sleep', bash: 'sleep 0.5' }],
    });
    const jid = 'cap-2@s.whatsapp.net';
    for (let i = 0; i < 10; i++) {
      store.createRun({
        id: `cap2-${i}`,
        workflow_name: 'a16-2',
        user_message: 'x',
        chat_jid: jid,
        artifacts_dir: join(artifactsRoot, `cap2-${i}`),
      });
    }
    const scanner = new ConcurrencyScanner({
      store,
      resolveWorkflow: () => workflow,
      executorDeps: { emitter },
      getCap: () => 2,
    });
    const dispatched = await scanner.scanOnce();
    expect(dispatched.length).toBe(2);
    const running = store
      .listRunsByStatus('running')
      .filter((r) => r.chat_jid === jid);
    expect(running.length).toBe(2);

    await new Promise((r) => setTimeout(r, 800));
  });
});

// ─── provider-bridge stub behavior ─────────────────────────────────────────

describe('provider-bridge — prompt node failure surface', () => {
  it('prompt node fails clearly when no invoker is set', async () => {
    const workflow = parseWorkflow({
      name: 'pn',
      description: 'prompt only',
      nodes: [{ id: 'p', prompt: 'hello world' }],
    });
    const { id: runId } = makeRun({ workflow_name: 'pn' });
    await executeWorkflow(runId, workflow, { store, emitter });
    const p = store.listNodesForRun(runId)[0];
    expect(p.state).toBe('failed');
    expect(p.error).toMatch(/NOT YET WIRED/);
  });

  it('test stub invoker runs prompt node end-to-end', async () => {
    const workflow = parseWorkflow({
      name: 'pn-stub',
      description: 'stub invoker',
      nodes: [{ id: 'p', prompt: 'echo $WORKFLOW_ID' }],
    });
    const { id: runId } = makeRun({ workflow_name: 'pn-stub' });
    const stubInvoker = vi.fn(async (opts) => ({
      output: `STUB:${opts.prompt}`,
    }));
    const restore = setProviderInvoker(stubInvoker);
    try {
      await executeWorkflow(runId, workflow, { store, emitter });
    } finally {
      restore();
    }
    const p = store.listNodesForRun(runId)[0];
    expect(p.state).toBe('completed');
    expect(p.output).toMatch(/^STUB:echo /);
    // Workflow var substitution happened before the invoker was called.
    expect(stubInvoker).toHaveBeenCalledTimes(1);
    const call = stubInvoker.mock.calls[0][0];
    expect(call.prompt).toBe(`echo ${runId}`);
  });
});

// ─── event emission ────────────────────────────────────────────────────────

describe('event emitter — sqlite + jsonl', () => {
  it('emits run_started → node_started → node_completed → run_completed', async () => {
    const workflow = parseWorkflow({
      name: 'ee',
      description: 'events',
      nodes: [{ id: 'a', bash: 'echo hi' }],
    });
    const { id: runId } = makeRun({ workflow_name: 'ee' });
    await executeWorkflow(runId, workflow, { store, emitter });
    const events = store.listEventsForRun(runId);
    const types = events.map((e) => e.event_type);
    expect(types[0]).toBe('workflow.run_started');
    expect(types).toContain('dag.layer_started');
    expect(types).toContain('dag.node_started');
    expect(types).toContain('dag.bash_completed');
    expect(types).toContain('dag.node_completed');
    expect(types[types.length - 1]).toBe('workflow.run_completed');
  });
});

// ─── event-loop liveness sketch (A18) ──────────────────────────────────────

describe('AC A18 — event-loop liveness via setImmediate yield', () => {
  it('yields between layers (yieldBetweenLayers spy fires once per layer transition)', async () => {
    const workflow = parseWorkflow({
      name: 'a18',
      description: 'AC A18',
      nodes: [
        { id: 'a', bash: 'echo a' },
        { id: 'b', bash: 'echo b' },
        { id: 'c', depends_on: ['a', 'b'], bash: 'echo c' },
      ],
    });
    const { id: runId } = makeRun({ workflow_name: 'a18' });
    const yieldSpy = vi.fn(async () => {});
    await executeWorkflow(runId, workflow, {
      store,
      emitter,
      yieldBetweenLayers: yieldSpy,
    });
    // Layers: [a, b], [c] → yield fires after each = 2 times.
    expect(yieldSpy).toHaveBeenCalledTimes(2);
  });
});
