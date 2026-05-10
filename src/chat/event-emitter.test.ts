/**
 * Hephaestus Port 4 — host-side event emitter tests.
 *
 * Asserts:
 *   - 250ms debounce window honored
 *   - 10-event cap forces immediate flush
 *   - Sequence numbers monotonic per delegationId
 *   - Retry-once-then-drop on persistent POST failure
 *   - chatJid → taskId mapping skips non-task JIDs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  chatJidToTaskId,
  enqueueEvent,
  _setEmitterDepsForTests,
  _flushAllForTests,
  _clearStateForTests,
} from './event-emitter.js';

describe('chatJidToTaskId', () => {
  it('extracts task id from delegate:task:<id>', () => {
    expect(chatJidToTaskId('delegate:task:abc-123')).toBe('abc-123');
    expect(chatJidToTaskId('delegate:task:cuid_with_underscores')).toBe('cuid_with_underscores');
  });

  it('returns null for non-task JIDs', () => {
    expect(chatJidToTaskId('delegate:main')).toBeNull();
    expect(chatJidToTaskId('delegate:conv:123')).toBeNull();
    expect(chatJidToTaskId('delegate:agent:profile-1')).toBeNull();
    expect(chatJidToTaskId('whatsapp:1234@g.us')).toBeNull();
  });
});

describe('event-emitter batching', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.DELEGATE_URL = 'http://test.local';
    process.env.DELEGATE_AGENT_TOKEN = 'tok-test';
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    _setEmitterDepsForTests({ fetch: fetchMock as unknown as typeof fetch });
    _clearStateForTests();
  });

  afterEach(() => {
    _clearStateForTests();
    delete process.env.DELEGATE_URL;
    delete process.env.DELEGATE_AGENT_TOKEN;
    _setEmitterDepsForTests({});
  });

  it('skips emission for non-task JIDs', async () => {
    enqueueEvent('delegate:main', { eventType: 'tool_use', payload: { tool: 'Bash' } });
    await _flushAllForTests();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('debounces: a single event waits for the 250ms window', async () => {
    enqueueEvent('delegate:task:t1', { eventType: 'tool_use', payload: { tool: 'Bash' } });
    // Don't flush yet — just confirm fetch wasn't called immediately.
    expect(fetchMock).not.toHaveBeenCalled();
    await _flushAllForTests();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.taskId).toBe('t1');
    expect(body.events).toHaveLength(1);
    expect(body.events[0].sequence).toBe(0);
  });

  it('caps batches at 10 events — 10th enqueue triggers immediate flush', async () => {
    for (let i = 0; i < 10; i++) {
      enqueueEvent('delegate:task:t2', {
        eventType: 'tool_use',
        payload: { idx: i },
      });
    }
    // 10-event cap fires synchronously; only need a microtask for the
    // promise to resolve.
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.events).toHaveLength(10);
  });

  it('assigns monotonic sequence numbers per delegation', async () => {
    for (let i = 0; i < 5; i++) {
      enqueueEvent('delegate:task:t3', { eventType: 'tool_use', payload: { idx: i } });
    }
    await _flushAllForTests();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const seqs = body.events.map((e: { sequence: number }) => e.sequence);
    expect(seqs).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps separate sequence counters per chatJid', async () => {
    enqueueEvent('delegate:task:tA', { eventType: 'tool_use', payload: {} });
    enqueueEvent('delegate:task:tB', { eventType: 'tool_use', payload: {} });
    enqueueEvent('delegate:task:tA', { eventType: 'tool_result', payload: {} });
    await _flushAllForTests();

    const callsByTask: Record<string, number[]> = {};
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse(call[1].body);
      callsByTask[body.taskId] = body.events.map((e: { sequence: number }) => e.sequence);
    }
    expect(callsByTask.tA).toEqual([0, 1]);
    expect(callsByTask.tB).toEqual([0]);
  });

  it('retries once on transient failure, then drops', async () => {
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    enqueueEvent('delegate:task:t4', { eventType: 'tool_use', payload: {} });
    await _flushAllForTests();
    // Wait the retry-backoff window deterministically.
    await new Promise((r) => setTimeout(r, 400));

    // First attempt + one retry = 2 calls. Then drop (no further calls).
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry on first-attempt success', async () => {
    fetchMock.mockReset().mockResolvedValue({ ok: true, status: 201 });
    enqueueEvent('delegate:task:t5', { eventType: 'tool_use', payload: {} });
    await _flushAllForTests();
    await new Promise((r) => setTimeout(r, 400));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips POST when DELEGATE_AGENT_TOKEN is absent', async () => {
    delete process.env.DELEGATE_AGENT_TOKEN;
    enqueueEvent('delegate:task:t6', { eventType: 'tool_use', payload: {} });
    await _flushAllForTests();
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
