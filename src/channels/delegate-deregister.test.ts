// Tests for terminal-task deregister teardown + poll jitter (2026-06-20).
//
// The groupSync disarm pass: when a JID disappears from registeredGroups()
// (Delegate DELETEd delegate:task:<id> on terminal status), the channel must
// stop its poller and drop per-JID state within one sync cycle. Always-on
// control JIDs are never disarmed.
//
// Jitter: startPoll staggers the first poll by a 0..POLL_INTERVAL offset so N
// JIDs don't fire in lock-step. DELEGATE_POLL_JITTER=0 restores lock-step.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DelegateChannel } from './delegate.js';
import type { ChannelOpts } from './registry.js';

function makeOpts(overrides: Partial<ChannelOpts> = {}): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn().mockReturnValue({}),
    ...overrides,
  };
}

function pollers(channel: DelegateChannel): Map<string, unknown> {
  return (channel as any).pollers as Map<string, unknown>;
}
function callStartPoll(channel: DelegateChannel, jid: string): void {
  (channel as any).startPoll(jid);
}
function callStopPoll(channel: DelegateChannel, jid: string): void {
  (channel as any).stopPoll(jid);
}

beforeEach(() => {
  vi.useFakeTimers();
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ messages: [] }),
  } as unknown as Response);
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.DELEGATE_POLL_JITTER;
});

describe('DelegateChannel — terminal-task deregister teardown', () => {
  it('stopPoll removes the poller and all per-JID state', () => {
    process.env.DELEGATE_POLL_JITTER = '0'; // deterministic: real interval slot
    const channel = new DelegateChannel(makeOpts());
    const jid = 'delegate:task:teardown-1';

    callStartPoll(channel, jid);
    expect(pollers(channel).has(jid)).toBe(true);
    expect((channel as any).lastSeen.has(jid)).toBe(true);
    expect((channel as any).seenIds.has(jid)).toBe(true);

    callStopPoll(channel, jid);

    expect(pollers(channel).has(jid)).toBe(false);
    expect((channel as any).lastSeen.has(jid)).toBe(false);
    expect((channel as any).seenIds.has(jid)).toBe(false);
    expect((channel as any).pollFailures.has(jid)).toBe(false);
  });

  it('stopPoll is idempotent (no throw on unknown jid)', () => {
    const channel = new DelegateChannel(makeOpts());
    expect(() => callStopPoll(channel, 'delegate:task:never')).not.toThrow();
  });

  it('isAlwaysOnJid protects main + agent control JIDs only', () => {
    const channel = new DelegateChannel(makeOpts());
    const isAlwaysOn = (jid: string) =>
      (channel as any).isAlwaysOnJid(jid) as boolean;
    expect(isAlwaysOn('delegate:main')).toBe(true);
    expect(isAlwaysOn('delegate:agent:abc')).toBe(true);
    expect(isAlwaysOn('delegate:task:abc')).toBe(false);
    expect(isAlwaysOn('delegate:conv:abc')).toBe(false);
  });
});

describe('DelegateChannel — poll jitter', () => {
  it('DELEGATE_POLL_JITTER=0 arms a real interval slot immediately (no sentinel)', () => {
    process.env.DELEGATE_POLL_JITTER = '0';
    const channel = new DelegateChannel(makeOpts());
    const jid = 'delegate:task:jitter-off';

    callStartPoll(channel, jid);
    // With jitter off, the slot is a live interval (not the JITTER_PENDING string).
    expect(typeof pollers(channel).get(jid)).not.toBe('string');
  });

  it('jitter ON marks the slot pending, then arms a real interval after the delay', () => {
    process.env.DELEGATE_POLL_JITTER = '1';
    // Force a non-zero offset deterministically.
    const randSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const channel = new DelegateChannel(makeOpts());
    const jid = 'delegate:task:jitter-on';

    callStartPoll(channel, jid);
    // During the jitter delay the slot is the pending sentinel.
    expect(pollers(channel).get(jid)).toBe('jitter-pending');
    expect(pollers(channel).has(jid)).toBe(true); // counts as "polling"

    // Advance past the offset (0.5 * POLL_INTERVAL) to fire the arm callback.
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(typeof pollers(channel).get(jid)).not.toBe('string');

    randSpy.mockRestore();
  });

  it('a JID stopped during the jitter delay does not arm afterward', () => {
    process.env.DELEGATE_POLL_JITTER = '1';
    const randSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const channel = new DelegateChannel(makeOpts());
    const jid = 'delegate:task:stop-during-jitter';

    callStartPoll(channel, jid);
    expect(pollers(channel).get(jid)).toBe('jitter-pending');

    callStopPoll(channel, jid); // deregistered mid-delay
    expect(pollers(channel).has(jid)).toBe(false);

    vi.advanceTimersByTime(10 * 60 * 1000); // delay would have elapsed
    // arm() guards on the slot — must NOT resurrect the poller.
    expect(pollers(channel).has(jid)).toBe(false);

    randSpy.mockRestore();
  });
});
