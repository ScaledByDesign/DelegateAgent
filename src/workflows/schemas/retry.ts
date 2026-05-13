/**
 * Zod schema for step retry configuration.
 *
 * Ported from Archon `packages/workflows/src/schemas/retry.ts`. The only
 * substantive difference is the import: Archon uses `@hono/zod-openapi`
 * because its REST server auto-generates the OpenAPI spec from these schemas.
 * DA uses plain `zod` — group-api routes don't share this shape.
 */
import { z } from 'zod';

export const stepRetryConfigSchema = z.object({
  /** Maximum retry attempts (not including the initial attempt). 1–5. */
  max_attempts: z
    .number()
    .int()
    .min(1, "'retry.max_attempts' must be between 1 and 5")
    .max(5, "'retry.max_attempts' must be between 1 and 5"),
  /** Initial delay in ms, doubled on each attempt. 1000–60000. */
  delay_ms: z
    .number()
    .min(1000, "'retry.delay_ms' must be a number between 1000 and 60000")
    .max(60000, "'retry.delay_ms' must be a number between 1000 and 60000")
    .optional(),
  /** Which error types trigger a retry. Default: 'transient'. */
  on_error: z.enum(['transient', 'all']).optional(),
});

export type StepRetryConfig = z.infer<typeof stepRetryConfigSchema>;
