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
import {
  buildApprovalIdForNode,
  isWorkflowPaused,
  openApprovalGate,
  type ResumeDecision,
} from './approval-gate.js';
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
  /** Terminal status of the run after this call. `paused` is not terminal —
   *  resumeWorkflow can pick it up later from the persisted ApprovalContext. */
  finalStatus: 'completed' | 'failed' | 'cancelled' | 'paused';
  failedNodes: readonly string[];
  /** When `finalStatus === 'paused'`, the approvalId the user must respond
   *  to via /api/workflows/runs/:id/resume (or the channel approval gate). */
  pausedApprovalId?: string;
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

  return runLayers({
    workflowRunId,
    workflow,
    deps,
    variables,
    // Fresh maps — no pre-existing state on initial execute.
    nodeOutputs: new Map(),
    nodeStates: new Map(),
    failedNodesSeed: [],
  });
}

/**
 * Resume a paused run. Loads the persisted ApprovalContext, applies the
 * caller's decision (approve / reject), rehydrates per-node state from the
 * store so already-completed nodes don't re-execute, and re-enters the
 * layer loop.
 *
 * **Constraint** (per `delegateagent_interaction_rules.md` Rule 1 +
 * Architect Q6/Q8): resumeWorkflow NEVER writes to TaskDelegation.status.
 * All run-level transitions go through `IWorkflowStore.updateRunStatus`.
 *
 * **Phase 4 limitation**: `on_reject` retry loop (re-run the approval node's
 * upstream with `$REJECTION_REASON`) is deferred to a Phase 4.5 follow-up.
 * For now, `decision: reject` with `on_reject` set still cancels the run;
 * the `onRejectPrompt` field on the ApprovalContext is persisted but not
 * acted upon. Approve / reject-without-on_reject paths ARE complete.
 */
export async function resumeWorkflow(
  workflowRunId: string,
  workflow: WorkflowDefinition,
  deps: ExecutorDeps,
  decision: ResumeDecision,
): Promise<ExecuteWorkflowResult> {
  const { store, emitter } = deps;

  const run = store.getRun(workflowRunId);
  if (!run) {
    throw new Error(`resumeWorkflow: run ${workflowRunId} not found`);
  }
  if (run.status !== 'paused') {
    throw new Error(
      `resumeWorkflow: run ${workflowRunId} status is '${run.status}', expected 'paused'`,
    );
  }
  const approval = run.metadata.approval as
    | {
        nodeId: string;
        type?: 'approval' | 'interactive_loop';
        captureResponse?: boolean;
        onRejectPrompt?: string;
        onRejectMaxAttempts?: number;
      }
    | undefined;
  if (!approval || typeof approval.nodeId !== 'string') {
    throw new Error(
      `resumeWorkflow: run ${workflowRunId} has no ApprovalContext in metadata.approval`,
    );
  }

  const variables = buildVariables(run, workflow);
  if (run.artifacts_dir) emitter.setArtifactsDir(run.id, run.artifacts_dir);

  // Rehydrate per-node state from SQLite. The runOneNode short-circuit at the
  // top of the function will see these completed/skipped/failed nodes and
  // skip them; downstream trigger-rule checks read the pre-pause states.
  const nodeStates = new Map<string, NodeState>();
  const nodeOutputs = new Map<string, NodeOutput>();
  const failedNodesSeed: string[] = [];
  for (const row of store.listNodesForRun(workflowRunId)) {
    // Skip the paused approval node itself — we'll re-decide its state below.
    if (row.node_id === approval.nodeId) continue;
    nodeStates.set(row.node_id, row.state);
    if (row.state === 'completed' || row.state === 'failed') {
      const base = { state: row.state, output: row.output ?? '' };
      const out =
        row.state === 'failed'
          ? ({ ...base, error: row.error ?? '' } as NodeOutput)
          : (base as NodeOutput);
      nodeOutputs.set(row.node_id, out);
      if (row.state === 'failed') failedNodesSeed.push(row.node_id);
    } else if (row.state === 'skipped') {
      nodeOutputs.set(row.node_id, { state: 'skipped', output: '' });
    }
  }

  // Decision dispatch.
  if (decision.decision === 'reject') {
    const rejectionReason = decision.reason;
    const onRejectPrompt = approval.onRejectPrompt;
    const onRejectMaxAttempts = approval.onRejectMaxAttempts ?? 3;
    const attemptsMap = (run.metadata.approval_attempts ?? {}) as Record<
      string,
      number
    >;
    const priorAttempts = attemptsMap[approval.nodeId] ?? 0;

    // Phase 4.5 — on_reject retry loop. When `on_reject.prompt` is configured
    // and the rejection budget isn't exhausted, the approval node's immediate
    // upstream prompt-producing predecessor re-runs with `$REJECTION_REASON`
    // populated, then the gate re-opens. Workflow authors get to ask the LLM
    // to revise its output before re-submitting for approval.
    //
    // Limitations of v1 (defer to v2):
    //   - Approval node MUST have exactly one upstream (depends_on[0]). If
    //     there are zero or multiple upstreams, the path falls back to the
    //     terminal-cancelled behavior (no node to re-run).
    //   - The upstream re-runs in full — there is no surgical "regenerate
    //     this field only" mode. Workflow authors design upstream prompts
    //     that read `$REJECTION_REASON` to revise their output.
    //   - The `onRejectPrompt` template (Archon convention) is NOT directly
    //     substituted as the next approval message — `$REJECTION_REASON`
    //     reaches the upstream via WorkflowVariables, which is the meaningful
    //     surface. The approval gate re-opens with the SAME message as the
    //     original approval node.
    const upstreamId = (() => {
      const node = workflow.nodes.find((n) => n.id === approval.nodeId);
      if (!node || !node.depends_on || node.depends_on.length !== 1) {
        return null;
      }
      const dep = node.depends_on[0];
      const depNode = workflow.nodes.find((n) => n.id === dep);
      // Only re-run nodes whose output the upstream could meaningfully
      // regenerate — prompt / command / loop. Bash / script nodes have no
      // notion of "revise based on rejection reason".
      if (!depNode) return null;
      if ('prompt' in depNode || 'command' in depNode || 'loop' in depNode) {
        return dep;
      }
      return null;
    })();

    if (
      onRejectPrompt &&
      upstreamId !== null &&
      priorAttempts < onRejectMaxAttempts
    ) {
      const nextAttempts = priorAttempts + 1;
      const nextAttemptsMap = {
        ...attemptsMap,
        [approval.nodeId]: nextAttempts,
      };

      // Re-runable: REMOVE approval + upstream from rehydrated maps so the
      // executor's runOneNode short-circuit doesn't skip them. The SQLite
      // store rows will be overwritten by ON CONFLICT DO UPDATE on next
      // setNodeState invocation.
      nodeStates.delete(approval.nodeId);
      nodeOutputs.delete(approval.nodeId);
      nodeStates.delete(upstreamId);
      nodeOutputs.delete(upstreamId);

      store.updateRunStatus(workflowRunId, {
        status: 'running',
        approval: null,
        metadata: {
          rejection_reason: rejectionReason,
          approval_attempts: nextAttemptsMap,
        },
      });
      emitter.emit({
        workflowRunId,
        nodeId: approval.nodeId,
        type: 'dag.approval_rejected',
        data: {
          reason: rejectionReason,
          attempt: nextAttempts,
          max_attempts: onRejectMaxAttempts,
          rerun_upstream: upstreamId,
        },
      });
      emitter.emit({
        workflowRunId,
        type: 'workflow.run_resumed',
        data: {
          approval_node_id: approval.nodeId,
          approval_type: 'approval',
          on_reject_attempt: nextAttempts,
        },
      });

      // Rebuild variables so REJECTION_REASON picks up the new metadata.
      const variablesWithReason = buildVariables(
        store.getRun(workflowRunId)!,
        workflow,
      );
      return runLayers({
        workflowRunId,
        workflow,
        deps,
        variables: variablesWithReason,
        nodeOutputs,
        nodeStates,
        failedNodesSeed,
      });
    }

    // Exhausted retry budget OR no on_reject configured → terminal cancel.
    store.setNodeState({
      run_id: workflowRunId,
      node_id: approval.nodeId,
      state: 'failed',
      error: `approval rejected: ${rejectionReason}`,
    });
    nodeStates.set(approval.nodeId, 'failed');
    nodeOutputs.set(approval.nodeId, {
      state: 'failed',
      output: '',
      error: `approval rejected: ${rejectionReason}`,
    });
    store.updateRunStatus(workflowRunId, {
      status: 'cancelled',
      approval: null,
      metadata: {
        rejection_reason: rejectionReason,
        ...(onRejectPrompt && priorAttempts >= onRejectMaxAttempts
          ? { on_reject_exhausted: true, on_reject_attempts: priorAttempts }
          : {}),
      },
    });
    emitter.emit({
      workflowRunId,
      nodeId: approval.nodeId,
      type: 'dag.approval_rejected',
      data: {
        reason: rejectionReason,
        attempt: priorAttempts,
        max_attempts: onRejectMaxAttempts,
        exhausted: onRejectPrompt
          ? priorAttempts >= onRejectMaxAttempts
          : false,
      },
    });
    emitter.emit({
      workflowRunId,
      type: 'workflow.run_cancelled',
      data: { reason: `approval rejected: ${rejectionReason}` },
    });
    emitter.closeRun(workflowRunId);
    return {
      runId: workflowRunId,
      finalStatus: 'cancelled',
      failedNodes: [...failedNodesSeed, approval.nodeId],
    };
  }

  // Approve path. Two flavors based on ApprovalContext.type:
  //
  //   - 'approval' (single-shot approval node): mark THE APPROVAL NODE
  //     completed, optionally capturing the response as its output, clear
  //     the approval context, transition run to running, re-enter layer loop.
  //
  //   - 'interactive_loop' (loop iteration pause): DO NOT mark a node
  //     completed — the loop node itself hasn't terminated yet. Instead,
  //     update the persisted loop_state with the user's response so the next
  //     iteration sees it as `$LOOP_USER_INPUT`. The loop runner reads
  //     loop_state on re-entry and resumes from iter N+1.
  if (approval.type === 'interactive_loop') {
    // Merge response into the existing loop_state for this nodeId.
    const allState = (run.metadata.loop_state ?? {}) as Record<
      string,
      { loopUserInput?: string } & Record<string, unknown>
    >;
    const existing = allState[approval.nodeId] ?? {};
    allState[approval.nodeId] = {
      ...existing,
      loopUserInput: decision.response ?? '',
    };
    // Loop node MUST NOT be in nodeStates as 'completed' — let runOneNode
    // re-enter it. Remove any stale entry that might have been rehydrated.
    nodeStates.delete(approval.nodeId);
    nodeOutputs.delete(approval.nodeId);
    store.updateRunStatus(workflowRunId, {
      status: 'running',
      approval: null,
      metadata: { loop_state: allState },
    });
    emitter.emit({
      workflowRunId,
      nodeId: approval.nodeId,
      type: 'dag.approval_approved',
      data: {
        captured_response_bytes: (decision.response ?? '').length,
        loop_iteration_approval: true,
      },
    });
    emitter.emit({
      workflowRunId,
      type: 'workflow.run_resumed',
      data: {
        approval_node_id: approval.nodeId,
        approval_type: 'interactive_loop',
      },
    });
    return runLayers({
      workflowRunId,
      workflow,
      deps,
      variables,
      nodeOutputs,
      nodeStates,
      failedNodesSeed,
    });
  }

  // Single-shot approval path.
  const approvedOutput =
    approval.captureResponse === true ? (decision.response ?? '') : '';
  store.setNodeState({
    run_id: workflowRunId,
    node_id: approval.nodeId,
    state: 'completed',
    output: approvedOutput,
  });
  nodeStates.set(approval.nodeId, 'completed');
  nodeOutputs.set(approval.nodeId, {
    state: 'completed',
    output: approvedOutput,
  });
  store.updateRunStatus(workflowRunId, {
    status: 'running',
    approval: null,
  });
  emitter.emit({
    workflowRunId,
    nodeId: approval.nodeId,
    type: 'dag.approval_approved',
    data: { captured_response_bytes: approvedOutput.length },
  });
  emitter.emit({
    workflowRunId,
    type: 'workflow.run_resumed',
    data: {
      approval_node_id: approval.nodeId,
      approval_type: approval.type ?? 'approval',
    },
  });

  return runLayers({
    workflowRunId,
    workflow,
    deps,
    variables,
    nodeOutputs,
    nodeStates,
    failedNodesSeed,
  });
}

interface RunLayersInput {
  workflowRunId: string;
  workflow: WorkflowDefinition;
  deps: ExecutorDeps;
  variables: WorkflowVariables;
  nodeOutputs: Map<string, NodeOutput>;
  nodeStates: Map<string, NodeState>;
  failedNodesSeed: readonly string[];
}

async function runLayers(
  input: RunLayersInput,
): Promise<ExecuteWorkflowResult> {
  const { workflowRunId, workflow, deps, variables, nodeOutputs, nodeStates } =
    input;
  const { store, emitter } = deps;

  const layers = buildTopologicalLayers(workflow.nodes);
  const failedNodes: string[] = [...input.failedNodesSeed];
  let runWasCancelled = false;
  let pausedSignal: {
    approvalId: string;
    message: string;
    approvalType: 'approval' | 'interactive_loop';
    nodeId: string;
    iteration?: number;
  } | null = null;

  outer: for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
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
        // Special case: WorkflowPaused is a control-flow signal, not a real
        // failure. Capture it + break out of the layer loop so we transition
        // the run to `paused` cleanly. Pause precedence is HIGHEST — if any
        // node in the layer paused, we honor the pause even when sibling
        // nodes also failed (those failures will re-surface on resume).
        if (isWorkflowPaused(result.reason)) {
          pausedSignal = {
            approvalId: result.reason.approvalId,
            // Surface the gate message + context type on the event payload
            // so channel renderers don't need a separate GET to render the
            // approval prompt (architect note, Phase 5).
            message: result.reason.approvalContext.message,
            approvalType: result.reason.approvalContext.type ?? 'approval',
            nodeId: result.reason.approvalContext.nodeId,
            iteration: result.reason.approvalContext.iteration,
          };
          // Persist the approval context now so a process crash before the
          // outer transition still surfaces a recoverable paused state.
          store.updateRunStatus(workflowRunId, {
            status: 'paused',
            approval: result.reason.approvalContext,
          });
          break outer;
        }
        // Real Promise rejection — internal bug; treat as a node-level FATAL.
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

  // Run terminal (or paused) transition.
  if (pausedSignal) {
    // The store.updateRunStatus({status: 'paused', approval}) call already
    // ran inside the layer loop (so a crash mid-emit leaves the row
    // recoverable). Here we just emit the pause event + close the run for
    // the JSONL sink. The run is NOT terminal — resumeWorkflow can pick it
    // up later.
    emitter.emit({
      workflowRunId,
      type: 'workflow.run_paused',
      data: {
        approval_id: pausedSignal.approvalId,
        message: pausedSignal.message,
        approval_type: pausedSignal.approvalType,
        node_id: pausedSignal.nodeId,
        iteration: pausedSignal.iteration ?? null,
      },
    });
    emitter.closeRun(workflowRunId);
    return {
      runId: workflowRunId,
      finalStatus: 'paused',
      failedNodes,
      pausedApprovalId: pausedSignal.approvalId,
    };
  }

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
  // Resume short-circuit: if this node already has a terminal state in the
  // rehydrated `nodeStates` map, do not re-execute. Phase 4 resume rehydrates
  // completed/skipped/failed nodes from SQLite before re-entering the layer
  // loop; we honor those states so downstream trigger-rule checks see the
  // pre-pause result instead of running the node again.
  const existing = ctx.nodeStates.get(node.id);
  if (
    existing === 'completed' ||
    existing === 'skipped' ||
    existing === 'failed'
  ) {
    return;
  }

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
    // WorkflowPaused is a control-flow signal — propagate so the outer
    // settled.rejected branch in executeWorkflow can recognize + handle.
    if (isWorkflowPaused(err)) throw err;
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

  // Loop nodes — Phase 3 (signal/until_bash) + Phase 4 (interactive).
  if (isLoopNode(node)) {
    return runLoopNode(node, {
      workflowRunId: ctx.workflowRunId,
      workflowProvider: ctx.workflow.provider,
      variables: ctx.variables,
      nodeOutputs: ctx.nodeOutputs,
      emitter: ctx.emitter,
      signal: ctx.signal,
      // Phase 4: needed for interactive loops to persist/restore iteration
      // state across pause/resume. Non-interactive loops ignore this.
      store: ctx.store,
    });
  }
  if (isApprovalNode(node)) {
    // Open the gate. Always throws WorkflowPaused, which propagates up
    // through runOneNode → settled.rejected branch in executeWorkflow,
    // where it's recognized and the run transitions to `paused`.
    openApprovalGate(ctx.workflowRunId, node);
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
  // Phase 4.5: REJECTION_REASON is sourced from metadata.rejection_reason so a
  // reject+on_reject re-entry (resumeWorkflow) can populate it before the
  // upstream prompt node re-runs. Cleared back to '' on next run terminal
  // transition or on approve resume.
  const rejectionReason =
    typeof run.metadata.rejection_reason === 'string'
      ? (run.metadata.rejection_reason as string)
      : '';
  return {
    WORKFLOW_ID: run.id,
    USER_MESSAGE: run.user_message,
    ARGUMENTS: run.user_message,
    ARTIFACTS_DIR: run.artifacts_dir ?? '',
    BASE_BRANCH: '',
    DOCS_DIR: 'docs',
    LOOP_USER_INPUT: '',
    REJECTION_REASON: rejectionReason,
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
