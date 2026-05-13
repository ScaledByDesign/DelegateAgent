// Phase 2 — shared executor utilities. Ported from Archon
// `packages/workflows/src/executor-shared.ts:43` (classifyError) and `:365`
// (substituteWorkflowVariables); $nodeId.output substitution lifted from
// `packages/workflows/src/dag-executor.ts:286` (substituteNodeOutputRefs).
//
// Logger and error-pattern lists are inline; Archon's pino imports are dropped
// in favor of DA's logger module.

import { logger } from '../../logger.js';
import type { NodeOutput } from '../schemas/index.js';

// ─── classifyError ──────────────────────────────────────────────────────────

/** A node-level error class:
 *   TRANSIENT — the executor can retry per `node.retry` config
 *   FATAL     — never retry; surfaces to the run as `failed` immediately
 */
export type ErrorClass = 'TRANSIENT' | 'FATAL';

/**
 * Substrings that classify an error as FATAL — checked FIRST so an error
 * carrying both a fatal token AND a transient one (e.g.
 * "unauthorized: process exited with code 1") isn't silently retried.
 */
const FATAL_PATTERNS: readonly string[] = [
  // Authentication / authorization
  'unauthorized',
  'authentication',
  'forbidden',
  '401',
  '403',
  // Credit / quota exhaustion (account-level, not retryable)
  'credit balance',
  'insufficient credits',
  'quota exceeded',
  'rate limit reached', // distinct from 'rate limit' transient overload
  // Permission denied at OS level
  'permission denied',
  'EACCES',
];

/**
 * Substrings that classify an error as TRANSIENT — only matched after the
 * FATAL list misses, so subprocess-exit codes and timeouts can retry.
 */
const TRANSIENT_PATTERNS: readonly string[] = [
  'exited with code', // subprocess non-zero exit (most bash node failures)
  'timeout',
  'timed out',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'socket hang up',
  'rate limit', // catch-all for transient overload; FATAL list catches 'rate limit reached'
  '503',
  '502',
];

/**
 * Classify an Error or error-like object as TRANSIENT (retryable) or FATAL.
 * Default: FATAL — never silently retry an error we don't recognize.
 */
export function classifyError(err: unknown): ErrorClass {
  const message = errorMessage(err).toLowerCase();
  for (const p of FATAL_PATTERNS) {
    if (message.includes(p.toLowerCase())) return 'FATAL';
  }
  for (const p of TRANSIENT_PATTERNS) {
    if (message.includes(p.toLowerCase())) return 'TRANSIENT';
  }
  return 'FATAL';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ─── Variable substitution ─────────────────────────────────────────────────

/**
 * Workflow-level variables. The executor populates these per-run and the
 * substitution helper expands them in `command:`/`prompt:`/`bash:`/`script:`
 * bodies. Names match Archon's documented surface.
 *
 * `LOOP_USER_INPUT` and `REJECTION_REASON` are only populated at interactive
 * loop iteration boundaries / approval rejections (Phase 3+4). Phase 2 leaves
 * them empty strings.
 */
export interface WorkflowVariables {
  WORKFLOW_ID: string;
  USER_MESSAGE: string;
  ARGUMENTS?: string;
  ARTIFACTS_DIR: string;
  BASE_BRANCH?: string;
  DOCS_DIR?: string;
  LOOP_USER_INPUT?: string;
  REJECTION_REASON?: string;
  LOOP_PREV_OUTPUT?: string;
}

const VARIABLE_KEYS: readonly (keyof WorkflowVariables)[] = [
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

/**
 * Substitute workflow-level variables (`$WORKFLOW_ID`, `$USER_MESSAGE`, etc.)
 * in a string body. Per Archon convention, variables are referenced as `$NAME`
 * (no braces). Substring matching is exact + boundary-aware so `$BASE_BRANCH`
 * doesn't partially match inside `$BASE_BRANCHED` (regex word-boundary).
 *
 * Unknown variable names pass through unchanged — bash node bodies that
 * reference `$PATH` or `$HOME` etc. survive substitution intact.
 */
export function substituteWorkflowVariables(
  body: string,
  vars: WorkflowVariables,
): string {
  let result = body;
  for (const key of VARIABLE_KEYS) {
    const value = vars[key];
    if (value === undefined) continue;
    // \b matches at end of $NAME so $BASE_BRANCH != $BASE_BRANCHED.
    const pattern = new RegExp(`\\$${key}\\b`, 'g');
    result = result.replace(pattern, value);
  }
  return result;
}

/**
 * Substitute `$nodeId.output` and `$nodeId.output.field` references in a body
 * using captured outputs from upstream nodes. Unknown nodes resolve to empty
 * string (logged at debug). Returns the new body.
 *
 * JSON dot-access semantics match `condition-evaluator.ts`: parse the upstream
 * node's output as JSON, take the named field. Empty string on parse failure.
 */
export function substituteNodeOutputRefs(
  body: string,
  nodeOutputs: Map<string, NodeOutput>,
): string {
  // $<nodeId>.output[.<field>] — node ids are kebab/snake; fields are word.
  const pattern =
    /\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?/g;
  return body.replace(pattern, (_match, nodeId: string, field?: string) => {
    const out = nodeOutputs.get(nodeId);
    if (!out) {
      logger.debug({ nodeId }, 'workflow_var_substitute_unknown_node');
      return '';
    }
    if (!out.output) return '';
    if (!field) return out.output;
    try {
      const parsed = JSON.parse(out.output) as Record<string, unknown>;
      const v = parsed[field];
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      if (Array.isArray(v) || typeof v === 'object') return JSON.stringify(v);
      return '';
    } catch {
      logger.debug(
        { nodeId, field },
        'workflow_var_substitute_json_parse_failed',
      );
      return '';
    }
  });
}

/** Combined substitution: workflow vars FIRST, then node-output refs. The
 *  ordering matters when a workflow variable happens to contain a `$ref`
 *  template — the var is expanded literally and the result is NOT re-scanned
 *  for node refs (prevents recursive expansion exploits). */
export function buildPromptWithContext(
  body: string,
  vars: WorkflowVariables,
  nodeOutputs: Map<string, NodeOutput>,
): string {
  const afterVars = substituteWorkflowVariables(body, vars);
  return substituteNodeOutputRefs(afterVars, nodeOutputs);
}
