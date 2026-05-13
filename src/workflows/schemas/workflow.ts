/**
 * Zod schemas for workflow definition types, plus result types for
 * workflow loading and execution (non-schema hand-written discriminated unions).
 *
 * Ported from Archon `packages/workflows/src/schemas/workflow.ts`. Import
 * swapped from `@hono/zod-openapi` to plain `zod`. Provider allowlist refine
 * (claude/nanoclaw in v1, see plan R3) is added on `workflowBaseSchema.provider`
 * so workflow-level provider declarations get the same rejection as per-node
 * declarations on `dagNodeBaseSchema.provider`.
 */
import { z } from 'zod';

import {
  ALLOWED_PROVIDERS,
  dagNodeSchema,
  effortLevelSchema,
  sandboxSettingsSchema,
  thinkingConfigSchema,
} from './dag-node.js';

// ---------------------------------------------------------------------------
// Shared enum schemas
// ---------------------------------------------------------------------------

export const modelReasoningEffortSchema = z.enum([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

export type ModelReasoningEffort = z.infer<typeof modelReasoningEffortSchema>;

export const webSearchModeSchema = z.enum(['disabled', 'cached', 'live']);

export type WebSearchMode = z.infer<typeof webSearchModeSchema>;

// ---------------------------------------------------------------------------
// Workflow-level worktree policy
// ---------------------------------------------------------------------------

export const workflowWorktreePolicySchema = z.object({
  /**
   * Pin worktree isolation on or off for this workflow.
   * - `true`  — always run inside a worktree; CLI `--no-worktree` hard-errors
   * - `false` — always run in the live checkout; CLI `--branch` / `--from`
   *             hard-error, orchestrator skips isolation resolution
   * - omitted — caller decides (current default = worktree for most types)
   *
   * Note: DA's `src/worktree-manager.ts` already isolates per-group. The
   * executor (Phase 2) uses `isolation-adapter.ts` to avoid double-isolation.
   */
  enabled: z.boolean().optional(),
});

export type WorkflowWorktreePolicy = z.infer<
  typeof workflowWorktreePolicySchema
>;

// ---------------------------------------------------------------------------
// WorkflowBase — common fields shared by all workflow types
// ---------------------------------------------------------------------------

export const workflowBaseSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  /** Provider allowlist refine mirrors `dagNodeBaseSchema.provider` (see dag-node.ts). */
  provider: z
    .string()
    .trim()
    .min(1)
    .refine(
      (v) => (ALLOWED_PROVIDERS as readonly string[]).includes(v),
      (v) => ({
        message: `provider '${v}' requires Bifrost VK config — see runbook. v1 allows only: ${ALLOWED_PROVIDERS.join(', ')}`,
      }),
    )
    .optional(),
  model: z.string().optional(),
  modelReasoningEffort: modelReasoningEffortSchema.optional(),
  webSearchMode: webSearchModeSchema.optional(),
  additionalDirectories: z.array(z.string()).optional(),
  interactive: z.boolean().optional(),
  effort: effortLevelSchema.optional(),
  thinking: thinkingConfigSchema.optional(),
  fallbackModel: z.string().min(1).optional(),
  betas: z
    .array(z.string().min(1))
    .nonempty("'betas' must be a non-empty array")
    .optional(),
  sandbox: sandboxSettingsSchema.optional(),
  worktree: workflowWorktreePolicySchema.optional(),
  /**
   * When `false`, the engine skips the path-exclusive lock for this workflow,
   * allowing N concurrent runs on the same live checkout. The author asserts
   * that concurrent runs will not race (e.g. all writes are per-run-scoped).
   * Defaults to `true` (safe: serialize runs on the same path).
   */
  mutates_checkout: z.boolean().optional(),
  tags: z.array(z.string().min(1)).optional(),
});

export type WorkflowBase = z.infer<typeof workflowBaseSchema>;

// ---------------------------------------------------------------------------
// WorkflowDefinition — DAG-based workflow with nodes
// ---------------------------------------------------------------------------

/**
 * Workflow definition parsed from YAML. All workflows use DAG-based
 * execution with `nodes`. The Hephaestus split-file shape (no top-level
 * `nodes:`) routes through the back-compat shim in `dag-loader.ts` and
 * does NOT validate against this schema.
 */
export const workflowDefinitionSchema = workflowBaseSchema.extend({
  nodes: z.array(dagNodeSchema),
});

/** Workflow definition with fully typed nodes (DagNode[]) derived from the schema. */
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema> & {
  prompt?: never;
};

// ---------------------------------------------------------------------------
// LoadCommandResult — discriminated union for command load outcomes
// ---------------------------------------------------------------------------

export type LoadCommandResult =
  | { success: true; content: string }
  | {
      success: false;
      reason:
        | 'invalid_name'
        | 'empty_file'
        | 'not_found'
        | 'permission_denied'
        | 'read_error';
      message: string;
    };

// ---------------------------------------------------------------------------
// WorkflowExecutionResult — discriminated union for execution outcomes
// ---------------------------------------------------------------------------

export type WorkflowExecutionResult =
  | { success: true; workflowRunId: string; summary?: string }
  | { success: false; workflowRunId?: string; error: string }
  | { success: true; paused: true; workflowRunId: string };

// ---------------------------------------------------------------------------
// WorkflowLoadError / WorkflowLoadResult — workflow discovery results
// ---------------------------------------------------------------------------

/**
 * Workflow origin:
 * - `bundled` — embedded in the agent binary (Phase 1.7).
 * - `project` — repo-local, discovered at `<DA root>/workflows/`.
 * - `hephaestus` — legacy split-layout workflows from the same `workflows/`
 *   directory; loaded by the Hephaestus shim, NOT the DAG schema.
 *
 * Precedence: `bundled` < `project` (project overrides bundled by name).
 */
// Phase 2: 'remote' added for workspace-scoped overrides fetched from the
// Delegate API (`GET /api/agent/workflows/dag/:name`). These take precedence
// over all local sources when `ARCHON_DAG_REMOTE_FETCH_ENABLED=1`.
export type WorkflowSource = 'bundled' | 'project' | 'hephaestus' | 'remote';

/** A workflow definition paired with its discovery source. */
export interface WorkflowWithSource {
  readonly workflow: WorkflowDefinition;
  readonly source: WorkflowSource;
}

/**
 * Error encountered while loading a workflow file
 */
export interface WorkflowLoadError {
  readonly filename: string;
  readonly error: string;
  readonly errorType: 'read_error' | 'parse_error' | 'validation_error';
}

/**
 * Result of workflow discovery - includes both successful loads and errors.
 */
export interface WorkflowLoadResult {
  readonly workflows: readonly WorkflowWithSource[];
  readonly errors: readonly WorkflowLoadError[];
}
