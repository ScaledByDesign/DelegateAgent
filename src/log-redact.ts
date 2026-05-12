/**
 * log-redact.ts — Helpers to strip sensitive env-var values from log output.
 *
 * Two forms are handled:
 *   - Array form:   docker run ... ["-e", "KEY=VALUE", ...]
 *                or docker run ... ["-e", "KEY=VALUE"]  (single merged token)
 *   - String form:  "docker run ... -e KEY=VALUE ..."
 *
 * Both return/produce new values — the input is never mutated.
 * No throws. If a match produces an unexpected shape the original element is
 * passed through unchanged.
 */

/** Keys whose values must never appear in log output. */
export const SENSITIVE_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DELEGATE_AGENT_TOKEN',
  'DELEGATE_API_KEY',
  'DELEGATE_API_TOKEN',
  'FORGETFUL_BEARER',
  'DELEGATE_AGENT_JWT',
  'BIFROST_API_KEY',
  'BIFROST_VK',
] as const;

// Pre-built regex for inline string replacement — matches KEY=<anything up to
// next whitespace or end-of-string> for every sensitive key.
const _inlinePattern = new RegExp(
  `((?:${SENSITIVE_KEYS.join('|')})=)[^\\s]*`,
  'g',
);

/**
 * redactSecretEnvArgs — returns a copy of `args` with sensitive `-e KEY=VALUE`
 * elements redacted.
 *
 * Docker CLI accepts env flags in two forms:
 *   Two-token: ["-e", "KEY=VALUE"]
 *   One-token: ["-e", "KEY=VALUE"]  (merged into a single string — rare but
 *              seen when callers join with spaces and re-split inconsistently)
 *
 * This function handles both:
 *   - A standalone element that IS "-e" followed by an element "KEY=VALUE" where
 *     KEY is sensitive → the "KEY=VALUE" element is replaced with "KEY=<redacted>".
 *   - A standalone element of the form "-e=KEY=VALUE" (rare) → also redacted.
 *   - A standalone element of the form "-eKEY=VALUE" is NOT a standard Docker flag
 *     and is passed through unchanged.
 *
 * The function never mutates the input array.
 */
export function redactSecretEnvArgs(args: readonly string[]): string[] {
  const sensitiveSet = new Set<string>(SENSITIVE_KEYS);
  const result: string[] = [];
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    // Handle two-token form: ["-e", "KEY=VALUE"]
    if (arg === '-e' && i + 1 < args.length) {
      const next = args[i + 1];
      const eqIdx = next.indexOf('=');
      if (eqIdx !== -1) {
        const key = next.slice(0, eqIdx);
        if (sensitiveSet.has(key)) {
          result.push('-e');
          result.push(`${key}=<redacted>`);
          i += 2;
          continue;
        }
      }
      // Not sensitive — push both as-is.
      result.push(arg);
      i++;
      continue;
    }

    // Handle one-token form: "-e=KEY=VALUE" (e.g. from some Docker SDK wrappers)
    if (arg.startsWith('-e=')) {
      const rest = arg.slice(3); // "KEY=VALUE"
      const eqIdx = rest.indexOf('=');
      if (eqIdx !== -1) {
        const key = rest.slice(0, eqIdx);
        if (sensitiveSet.has(key)) {
          result.push(`-e=${key}=<redacted>`);
          i++;
          continue;
        }
      }
    }

    result.push(arg);
    i++;
  }

  return result;
}

/**
 * redactInString — replaces sensitive KEY=<value> occurrences in a raw command
 * string with KEY=<redacted>. Handles the form produced by `.join(' ')` or
 * similar stringification of an args array.
 *
 * Values are considered to extend to the next whitespace character or
 * end-of-string. No throws.
 */
export function redactInString(str: string): string {
  return str.replace(_inlinePattern, '$1<redacted>');
}
