// Phase 2 — bash/script env allowlist (Architect decision A3: OneCLI
// credential boundary). Bash and script nodes spawn child processes that
// inherit the parent's env by default. To prevent accidental secret leaks
// (`$ANTHROPIC_API_KEY`, `$GITHUB_TOKEN`, etc.) we strip everything except a
// hand-curated allowlist.
//
// Layered with the load-time secret-pattern reject in `dag-loader.ts`:
//   - Load time: reject any bash/script body that names a `*_API_KEY` /
//     `*_SECRET` / `*_TOKEN` / `*_PASSWORD` variable. Defense in depth #1.
//   - Run time: strip secrets from the spawn env entirely. Even if the load
//     check is bypassed (hot-patch, generated body), the secret simply isn't
//     present in the subprocess's env to leak.
//
// Secrets continue to flow through OneCLI at request time — agents that need
// API access call `OneCLI.with({...})` inside the container, never via
// `process.env`.

import type { WorkflowVariables } from './executor-shared.js';

/**
 * Base allowlist — OS / shell essentials. These are safe to pass through to
 * subprocesses because they don't carry credentials.
 */
const BASE_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TZ',
  'USER',
  'LOGNAME',
  'SHELL',
  // npm/node basics so bash nodes can call `node`, `npm`, `npx` without
  // breaking under sandboxed envs.
  'NODE_OPTIONS',
  'NPM_CONFIG_USERCONFIG',
  // Locale fallbacks
  'LC_CTYPE',
  'LC_MESSAGES',
];

/** Per-workflow variables — exported separately so the executor can populate
 *  them at spawn time without leaking the value into the parent process. */
export const WORKFLOW_VAR_NAMES: readonly string[] = [
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
 * Build the env for a bash/script subprocess.
 *
 * Returns ONLY:
 *   - keys in BASE_ALLOWLIST that are set in `parentEnv`
 *   - all workflow vars from `vars` (literal values; empty string when undefined)
 *   - `nodeOutputs` keys formatted as `<NODE_ID_UPPER>_OUTPUT` (optional —
 *     callers typically inline these via substituteNodeOutputRefs and don't
 *     need them in env)
 *
 * Strips everything else, including (importantly) any `*_API_KEY`,
 * `*_SECRET`, `*_TOKEN`, `*_PASSWORD` keys that may live in the parent's env.
 */
export function buildSanitizedEnv(
  parentEnv: NodeJS.ProcessEnv,
  vars: WorkflowVariables,
  extraNodeOutputs?: Map<string, string>,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};

  for (const key of BASE_ALLOWLIST) {
    const v = parentEnv[key];
    if (typeof v === 'string') out[key] = v;
  }

  for (const key of WORKFLOW_VAR_NAMES) {
    const v = vars[key as keyof WorkflowVariables];
    out[key] = v ?? '';
  }

  if (extraNodeOutputs) {
    for (const [nodeId, output] of extraNodeOutputs) {
      const envKey = nodeId.replace(/-/g, '_').toUpperCase() + '_OUTPUT';
      out[envKey] = output;
    }
  }

  return out;
}

/**
 * Defense-in-depth: scan a string env value for substrings that look like a
 * leaked secret. Returns true if the value MIGHT be a secret. Used in
 * higher-level audit logs, NOT to gate the spawn (that's `buildSanitizedEnv`'s
 * job).
 */
export function looksLikeSecret(name: string, value: string): boolean {
  const n = name.toUpperCase();
  if (
    n.endsWith('_API_KEY') ||
    n.endsWith('_SECRET') ||
    n.endsWith('_TOKEN') ||
    n.endsWith('_PASSWORD')
  ) {
    return value.length >= 16;
  }
  return false;
}
