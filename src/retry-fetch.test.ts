// Tests for fetchWithRetry5xx — retry-on-5XX defense-in-depth wrapper.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithRetry5xx } from './retry-fetch.js';

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = ORIGINAL_FETCH;
});

function mockFetch(responses: Array<Response | Error>): ReturnType<typeof vi.fn> {
  const fn = vi.fn();
  for (const r of responses) {
    if (r instanceof Error) fn.mockRejectedValueOnce(r);
    else fn.mockResolvedValueOnce(r);
  }
  globalThis.fetch = fn;
  return fn;
}

const resp = (status: number) =>
  ({ ok: status >= 200 && status < 300, status, text: async () => '' }) as Response;

describe('fetchWithRetry5xx', () => {
  it('returns 200 immediately on success — no retry', async () => {
    const fetchMock = mockFetch([resp(200)]);
    const promise = fetchWithRetry5xx('https://x/', { method: 'GET' }, { label: 'test' });
    const res = await promise;
    expect(res?.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 4XX', async () => {
    const fetchMock = mockFetch([resp(400)]);
    const promise = fetchWithRetry5xx('https://x/', { method: 'POST' }, { label: 'test' });
    const res = await promise;
    expect(res?.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 503, succeeds on attempt 2', async () => {
    const fetchMock = mockFetch([resp(503), resp(200)]);
    const promise = fetchWithRetry5xx(
      'https://x/',
      { method: 'POST' },
      { label: 'test', baseDelayMs: 100 },
    );
    await vi.advanceTimersByTimeAsync(100); // first retry delay
    const res = await promise;
    expect(res?.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries on network error, succeeds on attempt 3', async () => {
    const fetchMock = mockFetch([
      new Error('ECONNRESET'),
      new Error('ETIMEDOUT'),
      resp(200),
    ]);
    const promise = fetchWithRetry5xx(
      'https://x/',
      { method: 'POST' },
      { label: 'test', baseDelayMs: 100 },
    );
    await vi.advanceTimersByTimeAsync(100); // attempt 2
    await vi.advanceTimersByTimeAsync(300); // attempt 3 (100 * 3^1)
    const res = await promise;
    expect(res?.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns final 503 after maxAttempts exhausted (does NOT return null)', async () => {
    const fetchMock = mockFetch([resp(503), resp(503), resp(503)]);
    const promise = fetchWithRetry5xx(
      'https://x/',
      { method: 'POST' },
      { label: 'test', baseDelayMs: 100 },
    );
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(300);
    const res = await promise;
    // 3rd attempt's 503 is returned (no further retry, since attempt >= maxAttempts)
    expect(res?.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns null after all attempts throw', async () => {
    const fetchMock = mockFetch([
      new Error('fail1'),
      new Error('fail2'),
      new Error('fail3'),
    ]);
    const promise = fetchWithRetry5xx(
      'https://x/',
      { method: 'POST' },
      { label: 'test', baseDelayMs: 100 },
    );
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(300);
    const res = await promise;
    expect(res).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('respects custom maxAttempts (1 = no retry)', async () => {
    const fetchMock = mockFetch([resp(503)]);
    const promise = fetchWithRetry5xx(
      'https://x/',
      { method: 'POST' },
      { label: 'test', maxAttempts: 1 },
    );
    const res = await promise;
    expect(res?.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
