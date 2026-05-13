// Phase 2 — provider bridge (injection seam).
//
// The DAG executor invokes prompt/command/loop AI nodes through this single
// function. v1 ships with `provider: claude` only (schema-allowlist refine in
// `dag-node.ts`). The actual wiring to the existing `container-runner.ts` →
// NanoClaw pipeline is a Phase 2.5 follow-up because:
//   1. `runContainerAgent` takes a RegisteredGroup + per-group IPC paths and
//      assumes the long-lived channel-poll loop; adapting it for one-shot
//      prompt-node execution from the DAG executor is its own integration
//      surface (touches `src/ipc.ts`, `src/container-runtime.ts`, group state).
//   2. Bash/script nodes deliver most of Phase 2's correctness value
//      (deterministic validation gates, post-processing, init scripts) and
//      can ship + verify end-to-end without NanoClaw.
//
// To keep tests + the adversarial-dev YAML structurally sound, this module
// exports a swappable invoker. Production wiring lands when NanoClaw
// integration is ready; tests inject a deterministic stub.

import type { DagNode } from '../schemas/index.js';

/** Result of invoking the AI provider for a prompt/command/loop iteration. */
export interface ProviderInvocationResult {
  /** Concatenated assistant text (or JSON string when output_format is set). */
  output: string;
  /** Optional session id for context-sharing across loop iterations. */
  sessionId?: string;
  /** Cost in USD for this invocation. Surfaced for AC accounting + R6 budget cap. */
  costUsd?: number;
}

/** Options passed to the invoker. v1 only forwards a subset of the node fields. */
export interface ProviderInvocationOptions {
  workflowRunId: string;
  nodeId: string;
  provider: 'claude' | 'nanoclaw';
  model?: string;
  prompt: string;
  systemPrompt?: string;
  allowedTools?: readonly string[];
  deniedTools?: readonly string[];
  /** When set, an explicit per-iteration session token. */
  sessionId?: string;
  /** When true, start a fresh agent session (loop nodes with fresh_context). */
  freshContext?: boolean;
  /** Workflow artifacts dir — passed to the agent's cwd / $ARTIFACTS_DIR. */
  artifactsDir: string;
  /** AbortSignal for cooperative cancel (cancelled run, executor shutdown). */
  signal?: AbortSignal;
  /** When set, hint the runtime to enforce a budget cap. */
  maxBudgetUsd?: number;
}

/** Type of the swappable invoker. */
export type ProviderInvoker = (
  opts: ProviderInvocationOptions,
) => Promise<ProviderInvocationResult>;

const NOT_WIRED_ERROR = new Error(
  'provider-bridge: AI prompt-node execution is NOT YET WIRED — Phase 2.5 follow-up. ' +
    'Only bash and script nodes execute end-to-end in Phase 2. ' +
    'Tests should call setProviderInvoker(...) with a stub. ' +
    'Production rollout follows Phase 2.5 (NanoClaw container-runner integration).',
);

const defaultInvoker: ProviderInvoker = async () => {
  throw NOT_WIRED_ERROR;
};

let currentInvoker: ProviderInvoker = defaultInvoker;

/**
 * Replace the provider invoker. Returns a restore function that undoes the
 * swap — useful for `afterEach(() => restore())` test cleanup.
 *
 * Production wiring (Phase 2.5) will call this once at boot from
 * `src/index.ts` with the NanoClaw-backed invoker. Tests call it per-test
 * with a deterministic stub.
 */
export function setProviderInvoker(invoker: ProviderInvoker): () => void {
  const previous = currentInvoker;
  currentInvoker = invoker;
  return () => {
    currentInvoker = previous;
  };
}

/** Invoke the AI provider for one prompt/command/loop iteration. */
export function invokeProvider(
  opts: ProviderInvocationOptions,
): Promise<ProviderInvocationResult> {
  return currentInvoker(opts);
}

/** Extract the provider identity for a node, honoring node → workflow → default. */
export function resolveProvider(
  node: DagNode,
  workflowProvider: string | undefined,
): 'claude' | 'nanoclaw' {
  const raw = (node.provider ?? workflowProvider ?? 'claude').toLowerCase();
  if (raw === 'claude' || raw === 'nanoclaw') return raw;
  // Schema refine should have rejected this at load time; defensively coerce.
  throw new Error(
    `provider-bridge: provider '${raw}' is not in the v1 allowlist (claude, nanoclaw). ` +
      'This indicates a bug — the workflow loader should have rejected this at parse.',
  );
}

/** @internal — for tests that want the default rejection path. */
export function _resetProviderInvoker(): void {
  currentInvoker = defaultInvoker;
}
