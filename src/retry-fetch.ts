// ─── fetchWithRetry5xx ───
// Shared retry helper for fire-and-forget POSTs to Delegate.
//
// Retries on:
//   - Network errors (fetch throws)
//   - HTTP 5XX (transient Vercel cold-start / DB hiccup)
//
// Does NOT retry on:
//   - HTTP 4XX (client error — body shape wrong, JID invalid, etc.)
//   - HTTP 200/202/3XX (success / redirect)
//
// Returns the final Response on success (any non-5XX), or null if all
// attempts are exhausted.  Never throws.

/**
 * Perform a fetch with automatic retry on 5XX and network errors.
 *
 * @param url          - Request URL.
 * @param init         - RequestInit (method, headers, body, signal, …).
 * @param opts.label   - Label used in console.warn/error messages.
 * @param opts.maxAttempts  - Maximum attempts (default 3).
 * @param opts.baseDelayMs  - Base delay in ms for exponential backoff (default 1000).
 *                            Delay schedule: baseDelayMs * 3^(attempt-1).
 *                            Attempt 1 → immediate, attempt 2 → 1 s, attempt 3 → 3 s.
 */
export async function fetchWithRetry5xx(
  url: string,
  init: RequestInit,
  opts: { maxAttempts?: number; baseDelayMs?: number; label: string },
): Promise<Response | null> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, init);

      if (res.status >= 500 && res.status < 600 && attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(3, attempt - 1);
        console.warn(
          `[${opts.label}] HTTP ${res.status} on attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      return res;
    } catch (err) {
      const e = err as Error;
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(3, attempt - 1);
        console.warn(
          `[${opts.label}] fetch threw "${e.message}" on attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      console.error(
        `[${opts.label}] all ${maxAttempts} attempts failed: ${e.message}`,
      );
      return null;
    }
  }

  return null;
}
