// Tests for the first-message cursor race fix in DelegateChannel.
//
// The bug: when a new task JID was registered at runtime, lastSeen was
// initialized to now(), so any message that arrived BEFORE registration
// (typically the original delegation prompt) was silently filtered out by the
// poll's `?since=` filter and the agent never saw it.
//
// The fix: initialize lastSeen to epoch (new Date(0)) for brand-new JIDs.
// JIDs loaded from delegate-cursors.json keep their persisted cursor.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DelegateChannel } from './delegate.js';
import type { ChannelOpts } from './registry.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const EPOCH = new Date(0).toISOString(); // 1970-01-01T00:00:00.000Z

function makeOpts(
  overrides: Partial<ChannelOpts> = {},
): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn().mockReturnValue({}),
    ...overrides,
  };
}

/** Access private `lastSeen` map via type escape. */
function getLastSeen(channel: DelegateChannel): Map<string, string> {
  return (channel as any).lastSeen as Map<string, string>;
}

/** Access private `startPoll` via type escape. */
function callStartPoll(channel: DelegateChannel, jid: string): void {
  (channel as any).startPoll(jid);
}

// ─── Fixture: mock fetch so startPoll's interval doesn't fire live requests ──

beforeEach(() => {
  vi.useFakeTimers();
  // Stub global fetch — poll() would otherwise throw in the test environment
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ messages: [] }),
  } as unknown as Response);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DelegateChannel — lastSeen cursor initialization', () => {
  it('sets lastSeen to epoch for a brand-new JID (no prior cursor)', () => {
    const channel = new DelegateChannel(makeOpts());
    const jid = 'delegate:task:test-brand-new';

    // Precondition: no prior cursor
    expect(getLastSeen(channel).has(jid)).toBe(false);

    callStartPoll(channel, jid);

    expect(getLastSeen(channel).get(jid)).toBe(EPOCH);
  });

  it('does NOT overwrite an existing lastSeen loaded from cursors.json', () => {
    const channel = new DelegateChannel(makeOpts());
    const jid = 'delegate:task:existing-cursor';
    const existingCursor = '2026-05-09T10:00:00.000Z';

    // Simulate a cursor restored from delegate-cursors.json
    getLastSeen(channel).set(jid, existingCursor);

    callStartPoll(channel, jid);

    // Must not overwrite
    expect(getLastSeen(channel).get(jid)).toBe(existingCursor);
    expect(getLastSeen(channel).get(jid)).not.toBe(EPOCH);
  });

  it('first poll after fresh registration sends since=epoch to the API', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [] }),
    } as unknown as Response);
    global.fetch = fetchMock;

    const channel = new DelegateChannel(makeOpts());
    const jid = 'delegate:task:poll-url-check';

    callStartPoll(channel, jid);

    // Advance past the poll interval (default 15 000ms) to trigger the first poll.
    // Use advanceTimersByTimeAsync (not runAllTimers) to avoid infinite-loop on
    // the repeating setInterval.
    await vi.advanceTimersByTimeAsync(20_000);

    expect(fetchMock).toHaveBeenCalled();
    const calledUrl: string = fetchMock.mock.calls[0][0] as string;
    // The URL must contain since=<epoch ISO>, not a recent timestamp
    expect(calledUrl).toContain(
      `since=${encodeURIComponent(EPOCH)}`,
    );
  });

  it('does not start duplicate pollers when startPoll is called twice for same JID', () => {
    const channel = new DelegateChannel(makeOpts());
    const jid = 'delegate:task:dedup-check';

    callStartPoll(channel, jid);
    const cursor1 = getLastSeen(channel).get(jid);

    callStartPoll(channel, jid); // second call should no-op
    const cursor2 = getLastSeen(channel).get(jid);

    // Cursor unchanged, still epoch
    expect(cursor1).toBe(EPOCH);
    expect(cursor2).toBe(EPOCH);

    // Internal pollers map should have exactly one entry
    const pollers = (channel as any).pollers as Map<string, unknown>;
    expect(pollers.size).toBe(1);
  });
});
