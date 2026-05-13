/**
 * Zod schema for loop node configuration.
 *
 * Ported from Archon `packages/workflows/src/schemas/loop.ts`.
 *
 * v1 hard cap on max_iterations: 50 (per plan R6 — Archon allows arbitrary;
 * we cap to prevent paid-model cost runaway from misconfiguration). Per-
 * workspace override via PlatformSetting `archon_loop_max_iterations_cap` is
 * enforced by the executor (Phase 2), not the schema, so workflow authors who
 * legitimately need higher caps can bump the setting without changing YAML.
 */
import { z } from 'zod';

export const loopNodeConfigSchema = z
  .object({
    /** Inline prompt text executed each iteration. */
    prompt: z
      .string()
      .min(1, "loop node requires 'loop.prompt' (non-empty string)"),
    /** Completion signal string detected in AI output (e.g., "COMPLETE"). */
    until: z
      .string()
      .min(1, "loop node requires 'loop.until' (completion signal string)"),
    /**
     * Maximum iterations allowed; exceeding this fails the node.
     * Hard cap 50 per plan R6 (cost-runaway risk).
     */
    max_iterations: z
      .number()
      .int()
      .positive("'loop.max_iterations' must be a positive integer")
      .max(
        50,
        "'loop.max_iterations' must be <= 50 in v1 (raise via PlatformSetting)",
      ),
    /** Whether to start fresh session each iteration (default: false). */
    fresh_context: z.boolean().default(false),
    /** Optional bash script run after each iteration; exit 0 = complete. */
    until_bash: z.string().optional(),
    /** When true, pause between iterations for user input via /workflow approve. */
    interactive: z.boolean().optional(),
    /** Message shown to user when paused (required when interactive is true). */
    gate_message: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.interactive === true && !data.gate_message) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "interactive loop requires 'loop.gate_message' (non-empty string)",
        path: ['gate_message'],
      });
    }
  });

export type LoopNodeConfig = z.infer<typeof loopNodeConfigSchema>;
