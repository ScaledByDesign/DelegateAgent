// Phase 2 — DAG executor core.
//
// Translates Archon's `packages/workflows/src/dag-executor.ts` topological
// runner, trigger-rule join semantics, conditional `when:` gate, and
// per-node-kind execution into DA's stack. Differences from upstream:
//
//   - In-process within DA's Node.js orchestrator (per Architect Q2). Bash
//     and script nodes spawn child processes; AI nodes go through
//     `provider-bridge.ts` (v1 stub — Phase 2.5 wires NanoClaw).
//   - Loop, approval, command nodes are scaffolded but throw `NOT_YET_WIRED`
//     so Phase 3 (loops) and Phase 4 (approvals) drop in cleanly.
//   - Persistence is the SQLite `IWorkflowStore` (Phase 1.5). No in-memory
//     authoritative state; `paused`/`running` survive process restarts.
//   - `await new Promise(setImmediate)` yields between topological layers so
//     channel pollers + IPC watcher in `src/index.ts` keep ticking (R11).
//
// What's exported:
//   - `executeWorkflow(workflowRunId, workflow, deps)` — top-level entry.
//     The caller (concurrency-scanner.ts, group-api.ts) holds the run row in
//     `running` state via `claimRun` BEFORE calling this; the executor only
//     manages per-node state + the run's terminal transition.

import { execFile } from 'child_process';
import { promisify } from 'util';

import { logger } from '../../logger.js';
import type {
  DagNode,
  NodeOutput,
  NodeState,
  WorkflowDefinition,
} from '../schemas/index.js';
import {
  isBashNode,
  isLoopNode,
  isApprovalNode,
  isCancelNode,
  isScriptNode,
} from '../schemas/index.js';
import type {
  IWorkflowStore,
  WorkflowRunRow,
} from '../store/IWorkflowStore.js';
import { evaluateCondition } from './condition-evaluator.js';
import { buildSanitizedEnv } from './env-sanitizer.js';
import type { WorkflowEventEmitter } from './event-emitter.js';
import {
  buildPromptWithContext,
  classifyError,
  substituteWorkflowVariables,
  type WorkflowVariables,
} from './executor-shared.js';
import { runLoopNode } from './loop-runner.js';
import { invokeProvider, resolveProvider } from './provider-bridge.js';

const execFileAsync = promisify(execFile);

// ─── public types ──────────────────────────────────────────────────────────

export interface ExecutorDeps {
  store: IWorkflowStore;
  emitter: WorkflowEventEmitter;
  /** Override for tests; defaults to setImmediate. */
  yieldBetweenLayers?: () => Promise<void>;
  /** Cooperative cancel signal (concurrency scanner sets on cancel). */
  signal?: AbortSignal;
}

export interface ExecuteWorkflowResult {
  runId: string;
  finalStatus: 'completed' | 'failed' | 'cancelled';
  failedNodes: readonly string[];
}

// ─── public entry ──────────────────────────────────────────────────────────

/**
 * Execute a workflow run end-to-end against the SQLite store. Assumes the
 * caller has already promoted the run from `pending → running` via
 * `IWorkflowStore.claimRun` (concurrency cap enforced at claim time).
 *
 * On error (run-level, not per-node), the run transitions to `failed` with
 * the orphan reason in metadata.
 */
export async function executeWorkflow(
  workflowRunId: string,
  workflow: WorkflowDefinition,
  deps: ExecutorDeps,
): Promise<ExecuteWorkflowResult> {
  const { store, emitter } = deps;

  const run = store.getRun(workflowRunId);
  if (!run) {
    throw new Error(`executeWorkflow: run ${workflowRunId} not found`);
  }
  if (run.status !== 'running') {
    throw new Error(
      `executeWorkflow: run ${workflowRunId} status is '${run.status}', expected 'running'`,
    );
  }

  const variables = buildVariables(run, workflow);

  if (run.artifacts_dir) emitter.setArtifactsDir(run.id, run.artifacts_dir);

  emitter.emit({
    workflowRunId,
    type: 'workflow.run_started',
    data: { workflow_name: workflow.name, node_count: workflow.nodes.length },
  });

  const layers = buildTopologicalLayers(workflow.nodes);
  const nodeOutputs = new Map<string, NodeOutput>();
  const nodeStates = new Map<string, NodeState>();
  const failedNodes: string[] = [];
  let runWasCancelled = false;

  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    if (deps.signal?.aborted) {
      runWasCancelled = true;
      break;
    }

    const layer = layers[layerIdx];
    emitter.emit({
      workflowRunId,
      type: 'dag.layer_started',
      data: { layer: layerIdx, node_ids: layer.map((n) => n.id) },
    });

    // Run all nodes in this layer in parallel.
    const settled = await Promise.allSettled(
      layer.map((node) =>
        runOneNode(node, {
          workflowRunId,
          workflow,
          variables,
          nodeOutputs,
          nodeStates,
          store,
          emitter,
          signal: deps.signal,
        }),
      ),
    );

    for (let i = 0; i < settled.length; i++) {
      const node = layer[i];
      const result = settled[i];
      if (result.status === 'rejected') {
        // Promise itself rejected — internal bug; treat as a node-level FATAL.
        const msg =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        failedNodes.push(node.id);
        nodeStates.set(node.id, 'failed');
        const out: NodeOutput = { state: 'failed', output: '', error: msg };
        nodeOutputs.set(node.id, out);
        store.setNodeState({
          run_id: workflowRunId,
          node_id: node.id,
          state: 'failed',
          error: msg,
        });
        emitter.emit({
          workflowRunId,
          nodeId: node.id,
          type: 'dag.node_failed',
          data: { error: msg, internal: true },
        });
      } else if (nodeStates.get(node.id) === 'failed') {
        // In-band failure (caught inside runOneNode → setNodeState already
        // ran). Mirror into failedNodes so the run's terminal transition
        // reflects "at least one node failed".
        failedNodes.push(node.id);
      }
    }

    emitter.emit({
      workflowRunId,
      type: 'dag.layer_completed',
      data: { layer: layerIdx },
    });

    // Yield so channel pollers + IPC watcher keep ticking (R11).
    await (deps.yieldBetweenLayers ?? defaultYield)();
  }

  // Run terminal transition.
  let finalStatus: 'completed' | 'failed' | 'cancelled';
  if (runWasCancelled) {
    finalStatus = 'cancelled';
  } else if (failedNodes.length > 0) {
    finalStatus = 'failed';
  } else {
    finalStatus = 'completed';
  }

  store.updateRunStatus(workflowRunId, {
    status: finalStatus,
    metadata: { failed_nodes: failedNodes },
  });
  emitter.emit({
    workflowRunId,
    type:
      finalStatus === 'completed'
        ? 'workflow.run_completed'
        : finalStatus === 'cancelled'
          ? 'workflow.run_cancelled'
          : 'workflow.run_failed',
    data: { failed_nodes: failedNodes },
  });
  emitter.closeRun(workflowRunId);

  return { runId: workflowRunId, finalStatus, failedNodes };
}

// ─── topological layering ──────────────────────────────────────────────────

/**
 * Group nodes into topological layers — independent nodes share a layer and
 * run in parallel. Throws on cycles. Used by `executeWorkflow` AND by tests
 * that want to assert the planned execution shape.
 */
export function buildTopologicalLayers(nodes: readonly DagNode[]): DagNode[][] {
  const byId = new Map<string, DagNode>();
  for (const n of nodes) byId.set(n.id, n);

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const n of nodes) {
    inDegree.set(n.id, n.depends_on?.length ?? 0);
    for (const dep of n.depends_on ?? []) {
      const list = dependents.get(dep) ?? [];
      list.push(n.id);
      dependents.set(dep, list);
    }
  }

  const layers: DagNode[][] = [];
  const remaining = new Set(nodes.map((n) => n.id));
  while (remaining.size > 0) {
    const layer: DagNode[] = [];
    for (const id of remaining) {
      if ((inDegree.get(id) ?? 0) === 0) {
        const node = byId.get(id);
        if (node) layer.push(node);
      }
    }
    if (layer.length === 0) {
      throw new Error(
        `dag-executor: cycle detected — no nodes with zero in-degree among ${[...remaining].join(', ')}`,
      );
    }
    for (const n of layer) {
      remaining.delete(n.id);
      for (const dep of dependents.get(n.id) ?? []) {
        inDegree.set(dep, (inDegree.get(dep) ?? 0) - 1);
      }
    }
    layers.push(layer);
  }
  return layers;
}

// ─── trigger rules ─────────────────────────────────────────────────────────

/**
 * Decide whether `node` should run given its upstream nodes' final states.
 * Returns `'run'`, `'skip'`, or `'wait'` — wait isn't expected in a strict
 * topo layering (deps always settle before the node in a later layer); we
 * surface it defensively for callers that maintain partial state.
 */
export function checkTriggerRule(
  node: DagNode,
  upstreamStates: ReadonlyMap<string, NodeState>,
): 'run' | 'skip' | 'wait' {
  const deps = node.depends_on ?? [];
  if (deps.length === 0) return 'run';

  let nSuccess = 0;
  let nFailed = 0;
  let nSkipped = 0;
  let nPending = 0;
  for (const dep of deps) {
    const s = upstreamStates.get(dep);
    if (s === 'completed') nSuccess++;
    else if (s === 'failed') nFailed++;
    else if (s === 'skipped') nSkipped++;
    else nPending++; // pending or running
  }
  if (nPending > 0) return 'wait';

  const rule = node.trigger_rule ?? 'all_success';
  switch (rule) {
    case 'all_success':
      return nFailed === 0 && nSkipped === 0 && nSuccess === deps.length
        ? 'run'
        : 'skip';
    case 'one_success':
      return nSuccess >= 1 ? 'run' : 'skip';
    case 'none_failed_min_one_success':
      return nFailed === 0 && nSuccess >= 1 ? 'run' : 'skip';
    case 'all_done':
      return 'run';
  }
}

// ─── per-node execution ────────────────────────────────────────────────────

interface RunOneNodeContext {
  workflowRunId: string;
  workflow: WorkflowDefinition;
  variables: WorkflowVariables;
  nodeOutputs: Map<string, NodeOutput>;
  nodeStates: Map<string, NodeState>;
  store: IWorkflowStore;
  emitter: WorkflowEventEmitter;
  signal?: AbortSignal;
}

async function runOneNode(
  node: DagNode,
  ctx: RunOneNodeContext,
): Promise<void> {
  // Trigger rule check first — earlier upstream skips short-circuit cascade.
  const decision = checkTriggerRule(node, ctx.nodeStates);
  if (decision === 'skip') {
    recordSkip(node, ctx, 'trigger_rule');
    return;
  }
  if (decision === 'wait') {
    // Shouldn't happen with strict topo layering. Skip rather than block forever.
    recordSkip(node, ctx, 'unsettled_upstream');
    return;
  }

  // `when:` conditional gate.
  if (node.when !== undefined) {
    const { result, parsed } = evaluateCondition(node.when, ctx.nodeOutputs);
    if (!parsed) {
      recordSkip(node, ctx, 'when_parse_failed');
      return;
    }
    if (!result) {
      recordSkip(node, ctx, 'when_false');
      return;
    }
  }

  // Mark running.
  ctx.nodeStates.set(node.id, 'running');
  ctx.store.setNodeState({
    run_id: ctx.workflowRunId,
    node_id: node.id,
    state: 'running',
  });
  ctx.emitter.emit({
    workflowRunId: ctx.workflowRunId,
    nodeId: node.id,
    type: 'dag.node_started',
    data: { kind: nodeKind(node) },
  });

  let output: NodeOutput;
  try {
    output = await executeNodeKind(node, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    output = { state: 'failed', output: '', error: msg };
  }

  ctx.nodeStates.set(node.id, output.state as NodeState);
  ctx.nodeOutputs.set(node.id, output);

  if (output.state === 'failed') {
    ctx.store.setNodeState({
      run_id: ctx.workflowRunId,
      node_id: node.id,
      state: 'failed',
      output: output.output,
      error: 'error' in output ? output.error : '',
    });
    ctx.emitter.emit({
      workflowRunId: ctx.workflowRunId,
      nodeId: node.id,
      type: 'dag.node_failed',
      data: {
        error: 'error' in output ? output.error : '',
        error_class: classifyError('error' in output ? output.error : ''),
      },
    });
  } else if (output.state === 'completed') {
    ctx.store.setNodeState({
      run_id: ctx.workflowRunId,
      node_id: node.id,
      state: 'completed',
      output: output.output,
      session_id: 'sessionId' in output ? output.sessionId : null,
    });
    ctx.emitter.emit({
      workflowRunId: ctx.workflowRunId,
      nodeId: node.id,
      type: 'dag.node_completed',
      data: { output_bytes: output.output.length },
    });
  }
}

function recordSkip(
  node: DagNode,
  ctx: RunOneNodeContext,
  reason: string,
): void {
  const out: NodeOutput = { state: 'skipped', output: '' };
  ctx.nodeStates.set(node.id, 'skipped');
  ctx.nodeOutputs.set(node.id, out);
  ctx.store.setNodeState({
    run_id: ctx.workflowRunId,
    node_id: node.id,
    state: 'skipped',
  });
  ctx.emitter.emit({
    workflowRunId: ctx.workflowRunId,
    nodeId: node.id,
    type: 'dag.node_skipped',
    data: { reason },
  });
}

function nodeKind(node: DagNode): string {
  if (isBashNode(node)) return 'bash';
  if (isScriptNode(node)) return 'script';
  if (isLoopNode(node)) return 'loop';
  if (isApprovalNode(node)) return 'approval';
  if (isCancelNode(node)) return 'cancel';
  if (
    'command' in node &&
    typeof (node as { command?: unknown }).command === 'string'
  )
    return 'command';
  return 'prompt';
}

// Concrete per-kind dispatch. Returns the captured NodeOutput.
async function executeNodeKind(
  node: DagNode,
  ctx: RunOneNodeContext,
): Promise<NodeOutput> {
  if (isBashNode(node)) return executeBashNode(node, ctx);
  if (isScriptNode(node)) return executeScriptNode(node, ctx);
  if (isCancelNode(node)) {
    ctx.emitter.emit({
      workflowRunId: ctx.workflowRunId,
      nodeId: node.id,
      type: 'dag.cancel_triggered',
      data: { reason: node.cancel },
    });
    return { state: 'failed', output: '', error: `cancel: ${node.cancel}` };
  }

  // Loop nodes — Phase 3.
  if (isLoopNode(node)) {
    return runLoopNode(node, {
      workflowRunId: ctx.workflowRunId,
      workflowProvider: ctx.workflow.provider,
      variables: ctx.variables,
      nodeOutputs: ctx.nodeOutputs,
      emitter: ctx.emitter,
      signal: ctx.signal,
    });
  }
  if (isApprovalNode(node)) {
    return {
      state: 'failed',
      output: '',
      error:
        'approval nodes execute in Phase 4 — not yet implemented in v1 executor',
    };
  }

  // Prompt / command — Phase 2.5 wires the NanoClaw provider invoker.
  return executePromptOrCommandNode(node, ctx);
}

// ─── bash node ──────────────────────────────────────────────────────────────

async function executeBashNode(
  node: DagNode & { bash: string; timeout?: number },
  ctx: RunOneNodeContext,
): Promise<NodeOutput> {
  ctx.emitter.emit({
    workflowRunId: ctx.workflowRunId,
    nodeId: node.id,
    type: 'dag.bash_started',
    data: { timeout: node.timeout },
  });

  const body = buildPromptWithContext(
    node.bash,
    ctx.variables,
    ctx.nodeOutputs,
  );
  const env = buildSanitizedEnv(process.env, ctx.variables);

  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-lc', body], {
      env,
      timeout: node.timeout ?? 60_000,
      maxBuffer: 16 * 1024 * 1024,
      cwd: ctx.variables.ARTIFACTS_DIR,
      signal: ctx.signal,
    });
    ctx.emitter.emit({
      workflowRunId: ctx.workflowRunId,
      nodeId: node.id,
      type: 'dag.bash_completed',
      data: { stdout_bytes: stdout.length, stderr_bytes: stderr.length },
    });
    return { state: 'completed', output: stdout };
  } catch (err) {
    const msg = formatExecFileError(err);
    ctx.emitter.emit({
      workflowRunId: ctx.workflowRunId,
      nodeId: node.id,
      type: 'dag.bash_failed',
      data: { error: msg, error_class: classifyError(msg) },
    });
    return { state: 'failed', output: '', error: msg };
  }
}

// ─── script node ────────────────────────────────────────────────────────────

async function executeScriptNode(
  node: DagNode & {
    script: string;
    runtime: 'bun' | 'uv';
    deps?: readonly string[];
    timeout?: number;
  },
  ctx: RunOneNodeContext,
): Promise<NodeOutput> {
  ctx.emitter.emit({
    workflowRunId: ctx.workflowRunId,
    nodeId: node.id,
    type: 'dag.script_started',
    data: { runtime: node.runtime, deps: node.deps ?? [] },
  });

  // v1: write the script body to a temp file inside ARTIFACTS_DIR and exec it.
  // Future: respect node.deps for `bun install` / `uv pip install` setup.
  const body = buildPromptWithContext(
    node.script,
    ctx.variables,
    ctx.nodeOutputs,
  );
  const env = buildSanitizedEnv(process.env, ctx.variables);
  const ext = node.runtime === 'bun' ? '.ts' : '.py';
  const tmpName = `.archon-script-${ctx.workflowRunId}-${node.id}${ext}`;
  const cwd = ctx.variables.ARTIFACTS_DIR;
  const fs = await import('fs');
  const path = await import('path');
  const tmpPath = path.join(cwd, tmpName);
  try {
    fs.writeFileSync(tmpPath, body, 'utf-8');
    const cmd = node.runtime === 'bun' ? 'bun' : 'uv';
    const args = node.runtime === 'bun' ? [tmpPath] : ['run', tmpPath];
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      env,
      timeout: node.timeout ?? 60_000,
      maxBuffer: 16 * 1024 * 1024,
      cwd,
      signal: ctx.signal,
    });
    ctx.emitter.emit({
      workflowRunId: ctx.workflowRunId,
      nodeId: node.id,
      type: 'dag.script_completed',
      data: { stdout_bytes: stdout.length, stderr_bytes: stderr.length },
    });
    return { state: 'completed', output: stdout };
  } catch (err) {
    const msg = formatExecFileError(err);
    ctx.emitter.emit({
      workflowRunId: ctx.workflowRunId,
      nodeId: node.id,
      type: 'dag.script_failed',
      data: { error: msg, error_class: classifyError(msg) },
    });
    return { state: 'failed', output: '', error: msg };
  } finally {
    try {
      const fs = await import('fs');
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore — script may have run cleanup
    }
  }
}

// ─── prompt / command node ──────────────────────────────────────────────────

async function executePromptOrCommandNode(
  node: DagNode,
  ctx: RunOneNodeContext,
): Promise<NodeOutput> {
  let body: string;
  if ('prompt' in node && typeof node.prompt === 'string') {
    body = node.prompt;
  } else if (
    'command' in node &&
    typeof (node as { command?: unknown }).command === 'string'
  ) {
    body = `[command:${(node as { command: string }).command}]`;
  } else {
    return { state: 'failed', output: '', error: 'unknown node kind' };
  }
  const prompt = buildPromptWithContext(body, ctx.variables, ctx.nodeOutputs);
  const provider = resolveProvider(node, ctx.workflow.provider);

  ctx.emitter.emit({
    workflowRunId: ctx.workflowRunId,
    nodeId: node.id,
    type: 'dag.prompt_started',
    data: { provider, model: node.model, prompt_bytes: prompt.length },
  });

  try {
    const result = await invokeProvider({
      workflowRunId: ctx.workflowRunId,
      nodeId: node.id,
      provider,
      model: node.model,
      prompt,
      systemPrompt:
        substituteWorkflowVariables(node.systemPrompt ?? '', ctx.variables) ||
        undefined,
      allowedTools: node.allowed_tools,
      deniedTools: node.denied_tools,
      artifactsDir: ctx.variables.ARTIFACTS_DIR,
      signal: ctx.signal,
      maxBudgetUsd: node.maxBudgetUsd,
    });
    ctx.emitter.emit({
      workflowRunId: ctx.workflowRunId,
      nodeId: node.id,
      type: 'dag.prompt_completed',
      data: { output_bytes: result.output.length, cost_usd: result.costUsd },
    });
    return {
      state: 'completed',
      output: result.output,
      sessionId: result.sessionId,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.emitter.emit({
      workflowRunId: ctx.workflowRunId,
      nodeId: node.id,
      type: 'dag.prompt_failed',
      data: { error: msg, error_class: classifyError(msg) },
    });
    return { state: 'failed', output: '', error: msg };
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function buildVariables(
  run: WorkflowRunRow,
  _workflow: WorkflowDefinition,
): WorkflowVariables {
  return {
    WORKFLOW_ID: run.id,
    USER_MESSAGE: run.user_message,
    ARGUMENTS: run.user_message,
    ARTIFACTS_DIR: run.artifacts_dir ?? '',
    BASE_BRANCH: '',
    DOCS_DIR: 'docs',
    LOOP_USER_INPUT: '',
    REJECTION_REASON: '',
    LOOP_PREV_OUTPUT: '',
  };
}

function formatExecFileError(err: unknown): string {
  if (err instanceof Error) {
    const e = err as Error & {
      code?: string | number | null;
      killed?: boolean;
      signal?: string | null;
      stderr?: string;
    };
    // Timeout detection: Node's execFile {timeout} kills the child with SIGTERM
    // and surfaces with code === null + signal === 'SIGTERM' on macOS/BSD and
    // killed === true on Linux. ETIMEDOUT can also appear as a string code.
    // Check the union so the test stays portable.
    if (
      e.killed ||
      e.signal === 'SIGTERM' ||
      (e.code === null && typeof e.signal === 'string')
    ) {
      return `timeout: process killed (${e.signal ?? 'unknown'})`;
    }
    if (typeof e.code === 'number')
      return `exited with code ${e.code}: ${e.message}`;
    if (typeof e.code === 'string' && e.code === 'ETIMEDOUT')
      return `timeout: ${e.message}`;
    return e.message;
  }
  return String(err);
}

function defaultYield(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

// ─── log namespace ──────────────────────────────────────────────────────────

export const _log = logger;
