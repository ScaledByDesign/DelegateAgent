/**
 * Hephaestus Port 2 — workflow types and validators.
 *
 * Mirrors Hephaestus's split layout: a top-level `workflow.yaml` (config) plus
 * one `phases/NN_<id>.yaml` file per phase. Validators are hand-rolled (no
 * zod dep on the agent side) and throw `WorkflowSchemaError` with a path
 * pointing at the bad field so the loader can surface useful errors.
 */

/** Optional user-defined pipeline step entry (Tier-1 §1B of
 *  .omc/plans/workflow-driven-task-dispatch.md). Variable-length array.
 *  DA passes this through to Delegate verbatim; Delegate's
 *  `lib/delegation/workflow-types.ts:workflowStepEntrySchema` is the
 *  authoritative validator. DA only checks the field is an array of objects. */
export interface WorkflowStepEntry {
  stage?: string;
  label?: string;
  agent_role?: string;
  agent_profile_id?: string;
  system_prompt?: string;
  goals?: string[];
  instructions?: string;
}

export interface WorkflowConfig {
  name: string;
  description: string;
  has_result: boolean;
  result_criteria: string;
  on_result_found: string;
  launch_template: string;
  phase_order: string[];
  /** Optional — user-defined pipeline steps for outer BMAD axis. */
  stages?: WorkflowStepEntry[];
}

export interface Phase {
  id: string;
  name: string;
  description: string;
  done_definitions: string[];
  working_directory: string;
  additional_notes: string;
  outputs: string[];
  next_steps: string[];
  cli_tool?: string;
  cli_model?: string;
}

export interface Workflow {
  config: WorkflowConfig;
  phases: Phase[];
}

/** Thrown by validators with a JSON-pointer-ish path so the loader can surface
 *  "workflows/bug-fix/workflow.yaml: phase_order[2]: must be string". */
export class WorkflowSchemaError extends Error {
  constructor(
    public readonly file: string,
    public readonly fieldPath: string,
    message: string,
  ) {
    super(`${file}: ${fieldPath}: ${message}`);
    this.name = 'WorkflowSchemaError';
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function requireString(
  obj: Record<string, unknown>,
  key: string,
  file: string,
): string {
  const v = obj[key];
  if (typeof v !== 'string') {
    throw new WorkflowSchemaError(
      file,
      key,
      `must be a string (got ${typeof v})`,
    );
  }
  return v;
}

function requireNonEmptyString(
  obj: Record<string, unknown>,
  key: string,
  file: string,
): string {
  const v = requireString(obj, key, file);
  if (v.trim() === '') {
    throw new WorkflowSchemaError(file, key, 'must be a non-empty string');
  }
  return v;
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  file: string,
): string | undefined {
  if (!(key in obj) || obj[key] === undefined || obj[key] === null) {
    return undefined;
  }
  return requireString(obj, key, file);
}

function requireBoolean(
  obj: Record<string, unknown>,
  key: string,
  file: string,
): boolean {
  const v = obj[key];
  if (typeof v !== 'boolean') {
    throw new WorkflowSchemaError(
      file,
      key,
      `must be a boolean (got ${typeof v})`,
    );
  }
  return v;
}

function requireStringArray(
  obj: Record<string, unknown>,
  key: string,
  file: string,
  { allowEmpty = true }: { allowEmpty?: boolean } = {},
): string[] {
  const v = obj[key];
  if (!Array.isArray(v)) {
    throw new WorkflowSchemaError(file, key, 'must be an array of strings');
  }
  if (!allowEmpty && v.length === 0) {
    throw new WorkflowSchemaError(file, key, 'must be a non-empty array');
  }
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] !== 'string') {
      throw new WorkflowSchemaError(
        file,
        `${key}[${i}]`,
        `must be a string (got ${typeof v[i]})`,
      );
    }
  }
  return v as string[];
}

// ─── validators ─────────────────────────────────────────────────────────────

const WORKFLOW_REQUIRED_KEYS = new Set([
  'name',
  'description',
  'has_result',
  'result_criteria',
  'on_result_found',
  'launch_template',
  'phase_order',
]);

/** Optional top-level keys — accepted but not required. */
const WORKFLOW_OPTIONAL_KEYS = new Set(['stages']);

const PHASE_REQUIRED_KEYS = new Set([
  'id',
  'name',
  'description',
  'done_definitions',
  'working_directory',
  'additional_notes',
  'outputs',
  'next_steps',
]);

const PHASE_OPTIONAL_KEYS = new Set(['cli_tool', 'cli_model']);

export function validateWorkflowConfig(
  raw: unknown,
  file: string,
): WorkflowConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new WorkflowSchemaError(
      file,
      '<root>',
      'workflow.yaml must be a YAML mapping',
    );
  }
  const obj = raw as Record<string, unknown>;
  // Reject entirely unknown top-level keys — schema drift should fail fast.
  for (const k of Object.keys(obj)) {
    if (!WORKFLOW_REQUIRED_KEYS.has(k) && !WORKFLOW_OPTIONAL_KEYS.has(k)) {
      throw new WorkflowSchemaError(file, k, 'unknown field for workflow.yaml');
    }
  }

  const cfg: WorkflowConfig = {
    name: requireNonEmptyString(obj, 'name', file),
    description: requireString(obj, 'description', file),
    has_result: requireBoolean(obj, 'has_result', file),
    result_criteria: requireString(obj, 'result_criteria', file),
    on_result_found: requireNonEmptyString(obj, 'on_result_found', file),
    launch_template: requireString(obj, 'launch_template', file),
    phase_order: requireStringArray(obj, 'phase_order', file, {
      allowEmpty: false,
    }),
  };

  // Optional `stages:` — pass-through, light validation. Delegate-side
  // `workflowStepEntrySchema` is the authoritative validator (Zod). Here we
  // only verify shape so a malformed YAML still fails loudly at load time.
  if ('stages' in obj && obj.stages !== undefined && obj.stages !== null) {
    const stages = obj.stages;
    if (!Array.isArray(stages)) {
      throw new WorkflowSchemaError(file, 'stages', 'must be an array');
    }
    for (let i = 0; i < stages.length; i++) {
      const entry = stages[i];
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new WorkflowSchemaError(
          file,
          `stages[${i}]`,
          'each step must be a YAML mapping',
        );
      }
    }
    cfg.stages = stages as WorkflowStepEntry[];
  }
  // phase_order entries must be unique
  const seen = new Set<string>();
  for (let i = 0; i < cfg.phase_order.length; i++) {
    const id = cfg.phase_order[i];
    if (seen.has(id)) {
      throw new WorkflowSchemaError(
        file,
        `phase_order[${i}]`,
        `duplicate phase id "${id}"`,
      );
    }
    seen.add(id);
  }
  return cfg;
}

export function validatePhase(raw: unknown, file: string): Phase {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new WorkflowSchemaError(
      file,
      '<root>',
      'phase file must be a YAML mapping',
    );
  }
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!PHASE_REQUIRED_KEYS.has(k) && !PHASE_OPTIONAL_KEYS.has(k)) {
      throw new WorkflowSchemaError(file, k, 'unknown field for phase file');
    }
  }
  return {
    id: requireNonEmptyString(obj, 'id', file),
    name: requireNonEmptyString(obj, 'name', file),
    description: requireString(obj, 'description', file),
    done_definitions: requireStringArray(obj, 'done_definitions', file, {
      allowEmpty: false,
    }),
    working_directory: requireString(obj, 'working_directory', file),
    additional_notes: requireString(obj, 'additional_notes', file),
    outputs: requireStringArray(obj, 'outputs', file),
    next_steps: requireStringArray(obj, 'next_steps', file),
    cli_tool: optionalString(obj, 'cli_tool', file),
    cli_model: optionalString(obj, 'cli_model', file),
  };
}
