/**
 * Zod schemas for the DAG workflow engine (Phase 1 of the Archon port).
 *
 * Types are derived from schemas via `z.infer<typeof Schema>`. The Hephaestus
 * Port 2 split-file shape (`workflow.yaml` + `phases/`) does NOT validate
 * against these schemas — it routes through the legacy validator in
 * `../types.ts`. Only single-file workflows with top-level `nodes:` use this
 * schema set. See `../dag-loader.ts` for the dispatching shim.
 */

// Retry configuration
export { stepRetryConfigSchema } from './retry.js';
export type { StepRetryConfig } from './retry.js';

// Loop node configuration
export { loopNodeConfigSchema } from './loop.js';
export type { LoopNodeConfig } from './loop.js';

// Hooks
export {
  workflowHookEventSchema,
  workflowHookMatcherSchema,
  workflowNodeHooksSchema,
  WORKFLOW_HOOK_EVENTS,
} from './hooks.js';
export type {
  WorkflowHookEvent,
  WorkflowHookMatcher,
  WorkflowNodeHooks,
} from './hooks.js';

// DAG node types
export {
  ALLOWED_PROVIDERS,
  triggerRuleSchema,
  TRIGGER_RULES,
  dagNodeBaseSchema,
  commandNodeSchema,
  promptNodeSchema,
  bashNodeSchema,
  loopNodeSchema,
  approvalNodeSchema,
  approvalOnRejectSchema,
  cancelNodeSchema,
  scriptNodeSchema,
  dagNodeSchema,
  isBashNode,
  isLoopNode,
  isApprovalNode,
  isCancelNode,
  isScriptNode,
  isTriggerRule,
  BASH_NODE_AI_FIELDS,
  SCRIPT_NODE_AI_FIELDS,
  LOOP_NODE_AI_FIELDS,
  effortLevelSchema,
  thinkingConfigSchema,
  sandboxSettingsSchema,
  agentDefinitionSchema,
} from './dag-node.js';
export type {
  AllowedProvider,
  TriggerRule,
  DagNodeBase,
  CommandNode,
  PromptNode,
  BashNode,
  LoopNode,
  ApprovalNode,
  ApprovalOnReject,
  CancelNode,
  ScriptNode,
  DagNode,
  EffortLevel,
  ThinkingConfig,
  SandboxSettings,
  AgentDefinition,
} from './dag-node.js';

// Workflow definition
export {
  modelReasoningEffortSchema,
  webSearchModeSchema,
  workflowBaseSchema,
  workflowDefinitionSchema,
  workflowWorktreePolicySchema,
} from './workflow.js';
export type {
  ModelReasoningEffort,
  WebSearchMode,
  WorkflowBase,
  WorkflowDefinition,
  WorkflowWorktreePolicy,
  LoadCommandResult,
  WorkflowExecutionResult,
  WorkflowLoadError,
  WorkflowLoadResult,
  WorkflowSource,
  WorkflowWithSource,
} from './workflow.js';

// Workflow run state
export {
  workflowRunStatusSchema,
  workflowStepStatusSchema,
  nodeStateSchema,
  nodeOutputSchema,
  workflowRunSchema,
  artifactTypeSchema,
  TERMINAL_WORKFLOW_STATUSES,
  RESUMABLE_WORKFLOW_STATUSES,
  isApprovalContext,
} from './workflow-run.js';
export type {
  WorkflowRunStatus,
  WorkflowStepStatus,
  NodeState,
  NodeOutput,
  WorkflowRun,
  ArtifactType,
  ApprovalContext,
} from './workflow-run.js';

// Command validation helper
export { isValidCommandName } from './command-validation.js';
