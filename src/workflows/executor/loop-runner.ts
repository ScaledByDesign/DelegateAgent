// Phase 3 — loop node iteration runner.
//
// Drives a `loop:` node through its iteration cycle. Each iteration:
//   1. Build the per-iteration prompt by substituting workflow vars + node
//      output refs INTO loop.prompt. `$LOOP_PREV_OUTPUT` is set to the
//      cleaned output of the previous iteration (empty string on iter 1).
//   2. Invoke the AI provider via provider-bridge. `fresh_context: true`
//      sends `sessionId: undefined` so the provider starts a clean session;
//      `false` (the default) reuses the prior iteration's session id.
//   3. Check completion:
//      - If `loop.until_bash` is set: run it with sanitized env; exit 0 means
//        complete (deterministic gate wins over signal detection).
//      - Else: substring-match `loop.until` in the iteration's output.
//   4. If complete → return the iteration's output as the loop node's final
//      `output`. If `max_iterations` is exhausted without completion → fail
//      with a clear "max_iterations exhausted" error.
//
// Interactive loops (`loop.interactive: true`) return a Phase-4 failure for
// now — that branch lands when the approval-gate mechanics ship.
//
// Architect Q2/R6 constraints honored:
//   - max_iterations is capped at 50 by the schema (loop.ts).
//   - All authoritative state goes through `IWorkflowStore` via the caller
//     in `dag-executor.ts`; the loop runner returns a `NodeOutput`, the
//     caller persists it.
//   - `await new Promise(setImmediate)` yields between iterations so the
//     channel pollers + IPC watcher keep ticking even during long loops.

import { execFile } from 'child_process';
import { promisify } from 'util';

import type { LoopNode, NodeOutput } from '../schemas/index.js';
import type { IWorkflowStore } from '../store/IWorkflowStore.js';
import { openInteractiveLoopGate } from './approval-gate.js';
import { buildSanitizedEnv } from './env-sanitizer.js';
import type { WorkflowEventEmitter } from './event-emitter.js';
import {
  buildPromptWithContext,
  type WorkflowVariables,
} from './executor-shared.js';
import { invokeProvider, resolveProvider } from './provider-bridge.js';

const execFileAsync = promisify(execFile);

export interface LoopRunnerCtx {
  workflowRunId: string;
  /** Workflow-level provider declaration; node.provider overrides if present. */
  workflowProvider: string | undefined;
  variables: WorkflowVariables;
  /** Captured upstream node outputs available for $nodeId.output substitution. */
  nodeOutputs: Map<
    string,
    {
      state: 'completed' | 'running' | 'failed' | 'pending' | 'skipped';
      output: string;
    }
  >;
  emitter: WorkflowEventEmitter;
  /** Cooperative cancel. */
  signal?: AbortSignal;
  /** Override for tests (default setImmediate). */
  yieldBetweenIterations?: () => Promise<void>;
  /**
   * Phase 4 — required for interactive loops with `loop.interactive: true`.
   * Loop state is persisted in `workflow_runs.metadata.loop_state[nodeId]`
   * before each pause so resume can pick up at iteration N+1 with prior
   * `prevOutput` + `sessionId` intact, AND read the user's approval
   * response as `$LOOP_USER_INPUT` on the next iteration. Non-interactive
   * loops do not touch this. Tests stub the store; production wires the
   * shared `IWorkflowStore`.
   */
  store?: IWorkflowStore;
}

/** Persisted loop state stored under `workflow_runs.metadata.loop_state[nodeId]`. */
interface PersistedLoopState {
  iter: number;
  prevOutput: string;
  sessionId?: string;
  lastIterationOutput: string;
  /** The user response from the most recent approval; populated as
   *  `$LOOP_USER_INPUT` on the next iteration's prompt. */
  loopUserInput?: string;
}

function readLoopState(
  store: IWorkflowStore | undefined,
  runId: string,
  nodeId: string,
): PersistedLoopState | null {
  if (!store) return null;
  const run = store.getRun(runId);
  if (!run) return null;
  const all = (run.metadata.loop_state ?? {}) as Record<
    string,
    PersistedLoopState
  >;
  const s = all[nodeId];
  return s && typeof s.iter === 'number' ? s : null;
}

function writeLoopState(
  store: IWorkflowStore | undefined,
  runId: string,
  nodeId: string,
  state: PersistedLoopState,
): void {
  if (!store) return;
  const run = store.getRun(runId);
  if (!run) return;
  const all = (run.metadata.loop_state ?? {}) as Record<
    string,
    PersistedLoopState
  >;
  all[nodeId] = state;
  store.updateRunStatus(runId, {
    status: run.status,
    metadata: { loop_state: all },
  });
}

function clearLoopState(
  store: IWorkflowStore | undefined,
  runId: string,
  nodeId: string,
): void {
  if (!store) return;
  const run = store.getRun(runId);
  if (!run) return;
  const all = (run.metadata.loop_state ?? {}) as Record<
    string,
    PersistedLoopState
  >;
  delete all[nodeId];
  store.updateRunStatus(runId, {
    status: run.status,
    metadata: { loop_state: all },
  });
}

/**
 * Run a loop node and return its terminal NodeOutput.
 *
 * The caller (`dag-executor.ts`) wraps this in the usual node lifecycle
 * (`dag.node_started` → result → `dag.node_completed`/`node_failed`); this
 * function emits the per-iteration events only.
 */
export async function runLoopNode(
  node: LoopNode,
  ctx: LoopRunnerCtx,
): Promise<NodeOutput> {
  const {
    until,
    until_bash,
    max_iterations,
    fresh_context,
    prompt,
    interactive,
    gate_message,
  } = node.loop;
  const provider = resolveProvider(node, ctx.workflowProvider);

  // Variables we mutate per iteration. `LOOP_PREV_OUTPUT` rolls forward.
  // Phase 4: interactive loops persist this state to SQLite before pausing so
  // resume can pick up at iter N+1 with the prior prevOutput / sessionId.
  let prevOutput = '';
  let sessionId: string | undefined;
  let lastIterationOutput = '';
  let startIter = 1;
  let loopUserInput = '';

  if (interactive === true) {
    const persisted = readLoopState(ctx.store, ctx.workflowRunId, node.id);
    if (persisted) {
      // Resume: start at iter N+1 (the iteration AFTER the one that paused).
      startIter = persisted.iter + 1;
      prevOutput = persisted.prevOutput;
      sessionId = persisted.sessionId;
      lastIterationOutput = persisted.lastIterationOutput;
      loopUserInput = persisted.loopUserInput ?? '';
    }
  }

  for (let iter = startIter; iter <= max_iterations; iter++) {
    if (ctx.signal?.aborted) {
      return {
        state: 'failed',
        output: lastIterationOutput,
        error: 'loop cancelled',
      };
    }

    ctx.emitter.emit({
      workflowRunId: ctx.workflowRunId,
      nodeId: node.id,
      type: 'dag.loop_iteration_started',
      data: {
        iteration: iter,
        fresh_context: fresh_context === true,
        has_until_bash: !!until_bash,
      },
    });

    const iterVars: WorkflowVariables = {
      ...ctx.variables,
      LOOP_PREV_OUTPUT: prevOutput,
      // Populated only on the iteration immediately after an interactive
      // pause was approved. Cleared after this iteration consumes it so iter
      // N+2 doesn't accidentally see iter N's user input.
      LOOP_USER_INPUT: loopUserInput,
    };
    const iterPrompt = buildPromptWithContext(
      prompt,
      iterVars,
      ctx.nodeOutputs as never,
    );
    // One-shot: consumed by THIS iteration only.
    loopUserInput = '';

    let iterResult;
    try {
      iterResult = await invokeProvider({
        workflowRunId: ctx.workflowRunId,
        nodeId: node.id,
        provider,
        model: node.model,
        prompt: iterPrompt,
        // fresh_context: true → send no sessionId so provider starts fresh.
        // false → reuse prior iteration's session for context continuity.
        sessionId: fresh_context === true ? undefined : sessionId,
        freshContext: fresh_context === true,
        artifactsDir: ctx.variables.ARTIFACTS_DIR,
        signal: ctx.signal,
        maxBudgetUsd: node.maxBudgetUsd,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.emitter.emit({
        workflowRunId: ctx.workflowRunId,
        nodeId: node.id,
        type: 'dag.loop_iteration_completed',
        data: { iteration: iter, ok: false, error: msg },
      });
      return { state: 'failed', output: lastIterationOutput, error: msg };
    }

    lastIterationOutput = iterResult.output;
    prevOutput = stripCompletionTags(iterResult.output, until);
    sessionId = iterResult.sessionId;

    // Check completion: deterministic gate wins over signal.
    const completed = await isLoopComplete(
      until,
      until_bash,
      iterResult.output,
      ctx.variables,
    );

    ctx.emitter.emit({
      workflowRunId: ctx.workflowRunId,
      nodeId: node.id,
      type: 'dag.loop_iteration_completed',
      data: {
        iteration: iter,
        ok: true,
        completed,
        output_bytes: iterResult.output.length,
      },
    });

    if (completed) {
      // Loop terminated; clear any persisted state from prior interactive
      // pauses so a workflow that re-enters this run id doesn't get stale
      // resume data.
      if (interactive === true) {
        clearLoopState(ctx.store, ctx.workflowRunId, node.id);
      }
      return { state: 'completed', output: lastIterationOutput, sessionId };
    }

    // Interactive pause: between iterations, persist state + open the gate.
    // The gate throws WorkflowPaused with an iter-suffixed approvalId; the
    // outer dag-executor catches it, transitions run.status='paused', and
    // returns. resumeWorkflow rehydrates approval + loopUserInput on next
    // entry.
    if (interactive === true) {
      writeLoopState(ctx.store, ctx.workflowRunId, node.id, {
        iter,
        prevOutput,
        sessionId,
        lastIterationOutput,
      });
      // gate_message is required by schema when interactive: true (loop.ts
      // superRefine), so the non-null assertion is safe.
      openInteractiveLoopGate(
        ctx.workflowRunId,
        node.id,
        gate_message as string,
        iter,
        sessionId,
        true, // captureResponse — the user's reply becomes $LOOP_USER_INPUT next iter
      );
    }

    // Yield between iterations so channel pollers + IPC keep ticking (R11).
    await (ctx.yieldBetweenIterations ?? defaultYield)();
  }

  if (interactive === true) {
    clearLoopState(ctx.store, ctx.workflowRunId, node.id);
  }
  return {
    state: 'failed',
    output: lastIterationOutput,
    error: `loop max_iterations (${max_iterations}) exhausted without completion signal '${until}'`,
  };
}

// ─── completion detection ──────────────────────────────────────────────────

async function isLoopComplete(
  until: string,
  untilBash: string | undefined,
  output: string,
  vars: WorkflowVariables,
): Promise<boolean> {
  // Deterministic gate wins: if `until_bash` is set, its exit status decides.
  // Signal-string detection is the AI-friendly fallback for workflows that
  // can't express completion as a shell test.
  if (untilBash) {
    const body = substituteVarsInline(untilBash, vars);
    const env = buildSanitizedEnv(process.env, vars);
    try {
      await execFileAsync('bash', ['-lc', body], {
        env,
        timeout: 30_000,
        maxBuffer: 1 * 1024 * 1024,
        cwd: vars.ARTIFACTS_DIR || process.cwd(),
      });
      return true; // exit 0 = complete
    } catch {
      return false;
    }
  }
  return output.includes(until);
}

/**
 * Remove the completion signal from the output so the next iteration's
 * `$LOOP_PREV_OUTPUT` doesn't immediately re-detect it. Trims trailing
 * whitespace too — most signals come at the end of the assistant reply.
 */
function stripCompletionTags(output: string, until: string): string {
  if (!until) return output.trim();
  return output.replace(new RegExp(escapeRegExp(until), 'g'), '').trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function substituteVarsInline(s: string, vars: WorkflowVariables): string {
  let r = s;
  const keys: (keyof WorkflowVariables)[] = [
    'WORKFLOW_ID',
    'USER_MESSAGE',
    'ARGUMENTS',
    'ARTIFACTS_DIR',
    'BASE_BRANCH',
    'DOCS_DIR',
    'LOOP_USER_INPUT',
    'REJECTION_REASON',
    'LOOP_PREV_OUTPUT',
  ];
  for (const k of keys) {
    const v = vars[k];
    if (v === undefined) continue;
    r = r.replace(new RegExp(`\\$${k}\\b`, 'g'), v);
  }
  return r;
}

function defaultYield(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
