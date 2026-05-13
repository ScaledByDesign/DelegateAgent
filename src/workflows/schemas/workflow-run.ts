/**
 * Zod schemas for workflow run state types.
 *
 * Ported from Archon `packages/workflows/src/schemas/workflow-run.ts`. Import
 * swapped from `@hono/zod-openapi` to `zod`. Field names that map onto DA's
 * data model are documented inline (chat_jid replaces conversation_id, etc.).
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// WorkflowRunStatus
// ---------------------------------------------------------------------------

export const workflowRunStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'paused',
]);

export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;

/** Statuses that indicate a run has finished and cannot transition further. */
export const TERMINAL_WORKFLOW_STATUSES: readonly WorkflowRunStatus[] = [
  'completed',
  'failed',
  'cancelled',
] as const;

/** Statuses that allow a user to resume execution. */
export const RESUMABLE_WORKFLOW_STATUSES: readonly WorkflowRunStatus[] = [
  'failed',
  'paused',
] as const;

// ---------------------------------------------------------------------------
// WorkflowStepStatus
// ---------------------------------------------------------------------------

export const workflowStepStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
]);

export type WorkflowStepStatus = z.infer<typeof workflowStepStatusSchema>;

// ---------------------------------------------------------------------------
// NodeState
// ---------------------------------------------------------------------------

export const nodeStateSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
]);

export type NodeState = z.infer<typeof nodeStateSchema>;

// ---------------------------------------------------------------------------
// NodeOutput
// ---------------------------------------------------------------------------

/**
 * Captured output from a completed DAG node.
 * `output` is the concatenated assistant text (or JSON-encoded string from the SDK
 * when output_format is set). Empty string for failed/skipped nodes.
 * `error` is required when state is 'failed', absent on all other states.
 */
export const nodeOutputSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.enum(['completed', 'running']),
    output: z.string(),
    sessionId: z.string().optional(),
  }),
  z.object({
    state: z.literal('failed'),
    output: z.string(),
    sessionId: z.string().optional(),
    error: z.string(),
  }),
  z.object({
    state: z.enum(['pending', 'skipped']),
    output: z.string(),
  }),
]);

export type NodeOutput = z.infer<typeof nodeOutputSchema>;

// ---------------------------------------------------------------------------
// WorkflowRun
// ---------------------------------------------------------------------------

/**
 * Runtime workflow run state stored in DA SQLite (`workflow_runs` table, see
 * plan Phase 1.5). Field name notes vs Archon:
 *  - `conversation_id` → `chat_jid` (DA convention; null for non-channel runs).
 *  - `parent_conversation_id` → not used; parent linkage is via
 *    `task_delegation_id` instead.
 *  - `codebase_id` → not modeled; DA's worktree manager owns repo identity.
 *  - `working_path` → `artifacts_dir`.
 *
 * Date fields here are `z.date()` to match the Archon shape. The DA SQLite
 * store serializes them as INTEGER ms-epoch and rehydrates on read.
 */
export const workflowRunSchema = z.object({
  id: z.string(),
  workflow_name: z.string(),
  chat_jid: z.string().nullable(),
  workspace_id: z.string().nullable(),
  task_id: z.string().nullable(),
  task_delegation_id: z.string().nullable(),
  user_id: z.string().nullable(),
  user_message: z.string(),
  status: workflowRunStatusSchema,
  metadata: z.record(z.string(), z.unknown()),
  artifacts_dir: z.string().nullable(),
  started_at: z.date(),
  completed_at: z.date().nullable(),
  last_activity_at: z.date().nullable(),
});

export type WorkflowRun = z.infer<typeof workflowRunSchema>;

/** Approval context stored in workflow run metadata when paused for human review. */
export interface ApprovalContext {
  nodeId: string;
  message: string;
  /** Distinguishes approval-gate pauses from interactive-loop pauses. */
  type?: 'approval' | 'interactive_loop';
  /** Current loop iteration when paused (interactive loops only). */
  iteration?: number;
  /** Session ID to restore on resume (interactive loops only). */
  sessionId?: string;
  /** When true, the user's approval comment is stored as `$nodeId.output`. */
  captureResponse?: boolean;
  /** The on_reject prompt template (stored at pause time). */
  onRejectPrompt?: string;
  /** Max rejection attempts before cancellation (default 3). */
  onRejectMaxAttempts?: number;
}

/**
 * Type guard for ApprovalContext. Use before accessing
 * `workflowRun.metadata.approval` to prevent runtime throws on malformed
 * metadata (e.g., stale data from older runs where metadata shape differs).
 */
export function isApprovalContext(val: unknown): val is ApprovalContext {
  return (
    typeof val === 'object' &&
    val !== null &&
    typeof (val as Record<string, unknown>).nodeId === 'string' &&
    typeof (val as Record<string, unknown>).message === 'string'
  );
}

// ---------------------------------------------------------------------------
// ArtifactType
// ---------------------------------------------------------------------------

export const artifactTypeSchema = z.enum([
  'pr',
  'commit',
  'file_created',
  'file_modified',
  'branch',
]);

export type ArtifactType = z.infer<typeof artifactTypeSchema>;

// ---------------------------------------------------------------------------
// Compile-time assertion: NodeOutput must cover all NodeState values.
// If NodeState gains a new value, this line becomes a type error as a reminder
// to update NodeOutput.
// ---------------------------------------------------------------------------

type AssertNodeOutputCoversNodeState = NodeOutput['state'] extends NodeState
  ? NodeState extends NodeOutput['state']
    ? true
    : never
  : never;
const nodeOutputStateCoverage: AssertNodeOutputCoversNodeState = true;
void nodeOutputStateCoverage; // suppress unused-variable lint warning
