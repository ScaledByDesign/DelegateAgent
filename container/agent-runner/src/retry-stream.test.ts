import { describe, it, expect, vi } from 'vitest';
import {
  isRetryableStreamError,
  withRetryableStream,
  RETRYABLE_PATTERNS,
} from './retry-stream.js';

// ---------------------------------------------------------------------------
// isRetryableStreamError
// ---------------------------------------------------------------------------

describe('isRetryableStreamError', () => {
  it('matches "Content block not found" (case-insensitive)', () => {
    expect(isRetryableStreamError(new Error('Content block not found'))).toBe(
      true,
    );
    expect(isRetryableStreamError(new Error('content block not found'))).toBe(
      true,
    );
    expect(
      isRetryableStreamError(new Error('CONTENT BLOCK NOT FOUND: index 3')),
    ).toBe(true);
  });

  it('matches "content_block_start"', () => {
    expect(
      isRetryableStreamError(
        new Error('received content_block_delta before content_block_start'),
      ),
    ).toBe(true);
  });

  it('matches "unexpected event"', () => {
    expect(
      isRetryableStreamError(new Error('unexpected event: content_block_delta')),
    ).toBe(true);
  });

  it('matches "stream interrupted"', () => {
    expect(
      isRetryableStreamError(new Error('stream interrupted mid-response')),
    ).toBe(true);
  });

  it('matches "ECONNRESET"', () => {
    expect(isRetryableStreamError(new Error('read ECONNRESET'))).toBe(true);
  });

  it('matches "socket hang up"', () => {
    expect(isRetryableStreamError(new Error('socket hang up'))).toBe(true);
  });

  it('does NOT match "Insufficient credits" (auth/billing errors)', () => {
    expect(
      isRetryableStreamError(
        new Error(
          'API Error: 402 {"type":"error","error":{"type":"api_error","message":"Insufficient credits..."}',
        ),
      ),
    ).toBe(false);
  });

  it('does NOT match generic auth failure', () => {
    expect(
      isRetryableStreamError(
        new Error('Failed to authenticate. API Error: 403'),
      ),
    ).toBe(false);
  });

  it('does NOT match unrelated error', () => {
    expect(isRetryableStreamError(new Error('ENOENT: no such file'))).toBe(
      false,
    );
  });

  it('handles non-Error objects by stringifying', () => {
    expect(isRetryableStreamError('Content block not found')).toBe(true);
    expect(isRetryableStreamError({ message: 'ECONNRESET' })).toBe(false); // toString() = [object Object]
  });

  it('RETRYABLE_PATTERNS array is exported for external inspection', () => {
    expect(Array.isArray(RETRYABLE_PATTERNS)).toBe(true);
    expect(RETRYABLE_PATTERNS.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// withRetryableStream
// ---------------------------------------------------------------------------

describe('withRetryableStream', () => {
  /**
   * Build a fake async iterable that yields the given values, then
   * optionally throws the given error.
   */
  function makeIterable<T>(
    values: T[],
    throwError?: Error,
  ): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        let i = 0;
        return {
          async next() {
            if (i < values.length) {
              return { value: values[i++], done: false };
            }
            if (throwError) {
              throw throwError;
            }
            return { value: undefined as unknown as T, done: true };
          },
        };
      },
    };
  }

  it('succeeds without retry when first call returns normally', async () => {
    const messages: string[] = [];
    const makeIterableFn = vi.fn((_fresh: boolean) =>
      makeIterable(['a', 'b', 'c']),
    );

    await withRetryableStream({
      makeIterable: makeIterableFn,
      onMessage: (m: string) => { messages.push(m); },
    });

    expect(messages).toEqual(['a', 'b', 'c']);
    expect(makeIterableFn).toHaveBeenCalledTimes(1);
    expect(makeIterableFn).toHaveBeenCalledWith(false); // isFreshSession=false on first call
  });

  it('retries once on "Content block not found" then succeeds', async () => {
    const retryError = new Error('Content block not found');
    const messages: string[] = [];
    const onRetry = vi.fn();

    let callCount = 0;
    const makeIterableFn = vi.fn((_fresh: boolean) => {
      callCount++;
      if (callCount === 1) {
        // First call: yield one message then throw
        return makeIterable(['first'], retryError);
      }
      // Second call: success
      return makeIterable(['second', 'third']);
    });

    await withRetryableStream({
      makeIterable: makeIterableFn,
      onMessage: (m: string) => { messages.push(m); },
      onRetry,
    });

    // Both iterables' messages are collected
    expect(messages).toEqual(['first', 'second', 'third']);
    expect(makeIterableFn).toHaveBeenCalledTimes(2);
    // First call: isFreshSession=false; second call: isFreshSession=true
    expect(makeIterableFn).toHaveBeenNthCalledWith(1, false);
    expect(makeIterableFn).toHaveBeenNthCalledWith(2, true);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith(1, retryError);
  });

  it('retries once on "ECONNRESET" then succeeds', async () => {
    const retryError = new Error('read ECONNRESET');
    const messages: string[] = [];

    let callCount = 0;
    const makeIterableFn = vi.fn((_fresh: boolean) => {
      callCount++;
      return callCount === 1
        ? makeIterable([], retryError)
        : makeIterable(['ok']);
    });

    await withRetryableStream({
      makeIterable: makeIterableFn,
      onMessage: (m: string) => { messages.push(m); },
    });

    expect(messages).toEqual(['ok']);
    expect(makeIterableFn).toHaveBeenCalledTimes(2);
  });

  it('propagates error after exhausting retries (both calls throw)', async () => {
    const retryError = new Error('Content block not found');

    const makeIterableFn = vi.fn((_fresh: boolean) =>
      makeIterable([], retryError),
    );

    await expect(
      withRetryableStream({
        makeIterable: makeIterableFn,
        onMessage: vi.fn(),
      }),
    ).rejects.toThrow('Content block not found');

    // Attempted twice: initial + 1 retry
    expect(makeIterableFn).toHaveBeenCalledTimes(2);
  });

  it('propagates "Insufficient credits" immediately without retry', async () => {
    const authError = new Error(
      'API Error: 402 {"type":"error","error":{"type":"api_error","message":"Insufficient credits"}',
    );

    const makeIterableFn = vi.fn((_fresh: boolean) =>
      makeIterable([], authError),
    );

    await expect(
      withRetryableStream({
        makeIterable: makeIterableFn,
        onMessage: vi.fn(),
      }),
    ).rejects.toThrow('Insufficient credits');

    // Only called once — no retry
    expect(makeIterableFn).toHaveBeenCalledTimes(1);
  });

  it('propagates non-retryable auth error immediately', async () => {
    const authError = new Error('Failed to authenticate. API Error: 403');
    const onRetry = vi.fn();

    const makeIterableFn = vi.fn((_fresh: boolean) =>
      makeIterable([], authError),
    );

    await expect(
      withRetryableStream({
        makeIterable: makeIterableFn,
        onMessage: vi.fn(),
        onRetry,
      }),
    ).rejects.toThrow('API Error: 403');

    expect(makeIterableFn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });
});
