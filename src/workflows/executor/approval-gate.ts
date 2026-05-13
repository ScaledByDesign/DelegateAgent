// Phase 4 — approval gate.
//
// Maps Archon's `approval:` node + `loop.interactive: true` semantics onto
// DA's existing `delegate-approvals` 409 + approvalId protocol while keeping
// the pause/resume mechanics entirely DA-SQLite-internal.
//
// Wire shape:
//   1. The executor (dag-executor.ts) or loop-runner reaches an approval
//      gate. It calls `openApprovalGate(...)` which builds an
//      `ApprovalContext` and THROWS `WorkflowPaused` carrying the context.
//   2. `executeWorkflow`'s outer try/catch recognizes `WorkflowPaused`,
//      persists `workflow_runs.status='paused'` + `metadata.approval`, emits
//      `workflow.run_paused`, and returns. NO `TaskDelegation.status` write
//      happens here — pause is purely DA-internal (Architect Q6).
//   3. (Phase 6 / Delegate-side, NOT in this file) When the feature flag is
//      on, an `AgentApproval` Prisma row is created with `type='workflow_approval'`
//      and `metadata.iteration` (for interactive loops) so the existing
//      delegate-approvals skill renders the 409 + approvalId envelope to the
//      end user / agent. Idempotency lookup at
//      `DP/lib/delegation/approval-gate.ts:144` MUST scope on
//      `(delegationId, status='pending', metadata.iteration=N)`.
//   4. On resume, group-api receives `/api/workflows/runs/:id/resume` with the
//      decision and calls `resumeWorkflow(...)` (in dag-executor.ts) which
//      rehydrates state + re-enters the layer loop. The approval node is
//      marked completed/failed based on the decision before the next layer.
//
// approvalId conventions (per plan §R9):
//   - Single-shot approval node:  `wf:${runId}:${nodeId}`
//   - Interactive loop iteration: `wf:${runId}:${nodeId}:iter${iteration}`
//
// Constraint reminders (per Architect Q6 + delegateagent_interaction_rules
// Rule 1): this module NEVER imports anything from the Delegate platform,
// NEVER writes `TaskDelegation.status`. The Delegate side's responsibility
// (Phase 6) is to mirror DA's `workflow_runs.status='paused'` into an
// AgentApproval row keyed by approvalId — but that mirror is independent of
// pause correctness on DA.

import type { ApprovalContext, ApprovalNode } from '../schemas/index.js';

/**
 * Thrown by `openApprovalGate(...)` to signal the executor that it must
 * pause the run. The outer `executeWorkflow` catches this, persists the
 * approval context to `workflow_runs.metadata.approval`, transitions the
 * run to `paused`, and returns cleanly.
 *
 * This is a control-flow signal, not an error condition — Sentry / log
 * helpers should NOT report it as a failure.
 */
export class WorkflowPaused extends Error {
  public readonly approvalContext: ApprovalContext;
  public readonly approvalId: string;

  constructor(approvalId: string, approvalContext: ApprovalContext) {
    super(
      `workflow paused at node '${approvalContext.nodeId}' (approvalId=${approvalId})`,
    );
    this.name = 'WorkflowPaused';
    this.approvalContext = approvalContext;
    this.approvalId = approvalId;
  }
}

/** Type guard for the WorkflowPaused signal — use instead of `instanceof` in
 *  contexts where the class identity might cross a module boundary. */
export function isWorkflowPaused(err: unknown): err is WorkflowPaused {
  return (
    err instanceof Error &&
    err.name === 'WorkflowPaused' &&
    // duck-type guard for cross-module instanceof robustness
    typeof (err as WorkflowPaused).approvalId === 'string' &&
    typeof (err as WorkflowPaused).approvalContext === 'object'
  );
}

// ─── approvalId builders ────────────────────────────────────────────────────

/** Build the approvalId for a single-shot approval node. */
export function buildApprovalIdForNode(runId: string, nodeId: string): string {
  return `wf:${runId}:${nodeId}`;
}

/** Build the approvalId for an interactive-loop iteration pause. */
export function buildApprovalIdForLoopIteration(
  runId: string,
  nodeId: string,
  iteration: number,
): string {
  return `wf:${runId}:${nodeId}:iter${iteration}`;
}

/** Parse an approvalId back into its components. Returns null on parse failure. */
export function parseApprovalId(
  approvalId: string,
): { runId: string; nodeId: string; iteration: number | null } | null {
  // Format: wf:<runId>:<nodeId>[:iter<N>]
  const m = /^wf:([^:]+):([^:]+)(?::iter(\d+))?$/.exec(approvalId);
  if (!m) return null;
  return {
    runId: m[1],
    nodeId: m[2],
    iteration: m[3] === undefined ? null : Number.parseInt(m[3], 10),
  };
}

// ─── gate openers ───────────────────────────────────────────────────────────

/**
 * Open the gate for a single-shot approval node.
 *
 * Throws `WorkflowPaused`. The caller (dag-executor.ts) propagates the throw
 * through `runOneNode` → up to the outer try/catch in `executeWorkflow`.
 */
export function openApprovalGate(runId: string, node: ApprovalNode): never {
  const ctx: ApprovalContext = {
    nodeId: node.id,
    message: node.approval.message,
    type: 'approval',
    captureResponse: node.approval.capture_response === true,
    onRejectPrompt: node.approval.on_reject?.prompt,
    onRejectMaxAttempts: node.approval.on_reject?.max_attempts ?? 3,
  };
  throw new WorkflowPaused(buildApprovalIdForNode(runId, node.id), ctx);
}

/**
 * Open the gate for an interactive-loop iteration.
 *
 * Throws `WorkflowPaused`. Carries the iteration number + sessionId so the
 * loop can resume mid-iteration when the user submits an approval response.
 */
export function openInteractiveLoopGate(
  runId: string,
  nodeId: string,
  gateMessage: string,
  iteration: number,
  sessionId: string | undefined,
  captureResponse: boolean,
): never {
  const ctx: ApprovalContext = {
    nodeId,
    message: gateMessage,
    type: 'interactive_loop',
    iteration,
    sessionId,
    captureResponse,
  };
  throw new WorkflowPaused(
    buildApprovalIdForLoopIteration(runId, nodeId, iteration),
    ctx,
  );
}

// ─── resume decision shape (consumed by resumeWorkflow) ────────────────────

export type ResumeDecision =
  | { decision: 'approve'; response?: string }
  | { decision: 'reject'; reason: string };
