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

function makeOpts(overrides: Partial<ChannelOpts> = {}): ChannelOpts {
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
    expect(calledUrl).toContain(`since=${encodeURIComponent(EPOCH)}`);
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

// ─── Fastpath JID gate tests ──────────────────────────────────────────────────
//
// These tests verify that task JIDs (and messages carrying a delegationId) are
// routed directly to the container path (onMessage) and NEVER passed to
// dispatchChatFastPath, per memory `feedback_chat_fastpath_not_for_agent_execution`.
//
// Mocking strategy:
//   - vi.mock('../chat/index.js') stubs dispatchChatFastPath so we can assert
//     it was NOT called for gated JIDs and WAS called for conversational JIDs.
//   - vi.mock('../metrics.js') stubs recordChannelMessageDelivered to avoid
//     real metric side-effects in unit tests.
//   - Inbound messages are injected by stubbing fetch to return a poll response
//     with a single message, then advancing fake timers past the poll interval.

vi.mock('../chat/index.js', () => ({
  dispatchChatFastPath: vi
    .fn()
    .mockResolvedValue({ handled: false, reason: 'too-long' }),
  setChatContextResolver: vi.fn(),
}));

vi.mock('../metrics.js', () => ({
  recordChannelPollError: vi.fn(),
  recordChannelMessageDelivered: vi.fn(),
}));

import { dispatchChatFastPath } from '../chat/index.js';
import { recordChannelMessageDelivered } from '../metrics.js';

/** Build a minimal poll response with one inbound message. */
function makePollResponse(
  overrides: {
    jid?: string;
    id?: string;
    text?: string;
    delegationId?: string;
  } = {},
) {
  return {
    ok: true,
    json: async () => ({
      messages: [
        {
          id: overrides.id ?? 'msg-1',
          text: overrides.text ?? 'hi',
          isAI: false,
          timestamp: new Date().toISOString(),
          sender: 'user',
          role: 'user',
          delegationId: overrides.delegationId ?? undefined,
          requestingUserId: 'user-123',
          workspaceId: 'ws-1',
        },
      ],
    }),
  } as unknown as Response;
}

describe('DelegateChannel — fastpath JID gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Fixture 1: task JID with short text → gate fires, fastpath NOT called,
  // onMessage IS called once with the inbound payload.
  it('1. task JID blocks fastpath and routes to onMessage', async () => {
    const jid = 'delegate:task:smoke';
    const onMessage = vi.fn();
    const channel = new DelegateChannel(makeOpts({ onMessage }));

    global.fetch = vi.fn().mockResolvedValue(makePollResponse({ jid }));

    callStartPoll(channel, jid);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(dispatchChatFastPath).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledTimes(1);
    const [calledJid, payload] = onMessage.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(calledJid).toBe(jid);
    expect(payload).toMatchObject({ chat_jid: jid, content: 'hi' });
  });

  // Fixture 2: chat JID → fastpath IS called (regression guard — chat JIDs unaffected).
  it('2. chat JID (delegate:chat:abc) still reaches fastpath', async () => {
    const jid = 'delegate:chat:abc';
    const channel = new DelegateChannel(makeOpts());

    global.fetch = vi.fn().mockResolvedValue(makePollResponse({ jid }));

    callStartPoll(channel, jid);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(dispatchChatFastPath).toHaveBeenCalled();
  });

  // Fixture 3: agent-room JID (delegate:agent:ceo) → fastpath IS called.
  // Agent rooms are conversational, not task dispatch.
  it('3. agent-room JID (delegate:agent:ceo) still reaches fastpath', async () => {
    const jid = 'delegate:agent:ceo';
    const channel = new DelegateChannel(makeOpts());

    global.fetch = vi.fn().mockResolvedValue(makePollResponse({ jid }));

    callStartPoll(channel, jid);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(dispatchChatFastPath).toHaveBeenCalled();
  });

  // Fixture 4: empty JID → isTaskJid=false, no delegationId → fastpath IS called.
  it('4. empty JID with no delegationId still reaches fastpath', async () => {
    const jid = '';
    const channel = new DelegateChannel(makeOpts());

    global.fetch = vi.fn().mockResolvedValue(makePollResponse({ jid }));

    callStartPoll(channel, jid);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(dispatchChatFastPath).toHaveBeenCalled();
  });

  // Fixture 5: task JID with no id suffix → treated as task defensively,
  // gate fires, fastpath NOT called.
  it('5. bare delegate:task: prefix (no id) still gates fastpath defensively', async () => {
    const jid = 'delegate:task:';
    const onMessage = vi.fn();
    const channel = new DelegateChannel(makeOpts({ onMessage }));

    global.fetch = vi.fn().mockResolvedValue(makePollResponse({ jid }));

    callStartPoll(channel, jid);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(dispatchChatFastPath).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  // Fixture 6: conv JID + msg.delegationId → hasDelegationId branch fires,
  // fastpath NOT called, onMessage IS called.
  it('6. conv JID with delegationId gates via hasDelegationId branch', async () => {
    const jid = 'delegate:conv:x';
    const onMessage = vi.fn();
    const channel = new DelegateChannel(makeOpts({ onMessage }));

    global.fetch = vi
      .fn()
      .mockResolvedValue(makePollResponse({ jid, delegationId: 'abc' }));

    callStartPoll(channel, jid);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(dispatchChatFastPath).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledTimes(1);
    const [calledJid, payload] = onMessage.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(calledJid).toBe(jid);
    expect(payload).toMatchObject({ delegation_id: 'abc' });
  });
});
