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
  // Phase 4: interactive loops. Until then, fail-fast with a clear pointer.
  if (node.loop.interactive === true) {
    return {
      state: 'failed',
      output: '',
      error:
        'interactive loops execute in Phase 4 (approval pause/resume) — not yet implemented in v1 executor',
    };
  }

  const { until, until_bash, max_iterations, fresh_context, prompt } =
    node.loop;
  const provider = resolveProvider(node, ctx.workflowProvider);

  // Variables we mutate per iteration. `LOOP_PREV_OUTPUT` rolls forward.
  let prevOutput = '';
  let sessionId: string | undefined;
  let lastIterationOutput = '';

  for (let iter = 1; iter <= max_iterations; iter++) {
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
    };
    const iterPrompt = buildPromptWithContext(
      prompt,
      iterVars,
      ctx.nodeOutputs as never,
    );

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
      return { state: 'completed', output: lastIterationOutput, sessionId };
    }

    // Yield between iterations so channel pollers + IPC keep ticking (R11).
    await (ctx.yieldBetweenIterations ?? defaultYield)();
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
