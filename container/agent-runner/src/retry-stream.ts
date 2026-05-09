/**
 * Retry wrapper for the SDK's `for await (const message of query(...))` loop.
 *
 * The Anthropic SDK streaming parser throws "Content block not found" (and
 * related errors) when Bifrost drops SSE events under load or when a
 * multi-message resume race leaves the parser in an inconsistent state.
 * Network-level drops produce ECONNRESET / "socket hang up".
 *
 * These are transient — the right recovery is one retry with a fresh session
 * (resumeSessionAt: undefined) so the parser starts from a clean state.
 * Non-transient errors (auth failures, credit exhaustion, etc.) propagate
 * immediately without a retry.
 */

export const RETRYABLE_PATTERNS: RegExp[] = [
  /content block not found/i,
  /content_block_start/i,
  /unexpected event/i,
  /stream interrupted/i,
  /ECONNRESET/i,
  /socket hang up/i,
];

export function isRetryableStreamError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return RETRYABLE_PATTERNS.some((p) => p.test(msg));
}

export interface RetryStreamOptions<T> {
  /** Maximum number of retries (not counting the initial attempt). Default: 1 */
  maxRetries?: number;
  /** Called on each retryable error before the next attempt. Receives 1-based attempt number. */
  onRetry?: (attempt: number, err: unknown) => void;
  /**
   * Factory that produces the async iterable for each attempt.
   * Receives `isFreshSession: true` on retry attempts (caller should clear
   * resumeSessionAt so the SDK starts a new session).
   */
  makeIterable: (isFreshSession: boolean) => AsyncIterable<T>;
  /** Handler for each yielded message. */
  onMessage: (message: T) => void | Promise<void>;
}

/**
 * Run `options.makeIterable()` and drive its `for await` loop.
 * On a retryable error, waits `backoffMs` then calls `makeIterable(true)`
 * (fresh-session flag) and retries once.
 */
export async function withRetryableStream<T>(
  options: RetryStreamOptions<T>,
): Promise<void> {
  const { maxRetries = 1, onRetry, makeIterable, onMessage } = options;
  const BACKOFF_MS = 1_000;

  let attempt = 0;

  while (true) {
    try {
      const iterable = makeIterable(attempt > 0);
      for await (const message of iterable) {
        await onMessage(message);
      }
      return; // success
    } catch (err) {
      if (attempt < maxRetries && isRetryableStreamError(err)) {
        attempt++;
        if (onRetry) {
          onRetry(attempt, err);
        }
        await new Promise<void>((r) => setTimeout(r, BACKOFF_MS * attempt));
        continue;
      }
      throw err; // non-retryable or out of retries
    }
  }
}
