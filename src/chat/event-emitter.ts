// ─── Hephaestus Port 4 — Agent tool-call event emitter (host side) ───
//
// The container-runner emits per-message tool-call events to stdout via the
// EVENT marker pair. The host parses these and feeds them here. We batch per
// chatJid (250ms debounce OR 10-event cap, whichever first) and POST to
// Delegate's `/api/agent/channel/event` endpoint.
//
// Fire-and-forget. One retry with 250ms backoff on transient failures, then
// drop. Sentry-equivalent reporting is the host logger — never block the
// agent on event-stream failures.
//
// Sequence numbers are monotonic per delegationId for a given emitter
// process. They reset on agent restart; the Delegate side handles overlap
// via the (delegationId, sequence) unique constraint + skipDuplicates.

import { logger } from '../logger.js';
import { getEnvWithFallback } from '../config.js';

// ─── Config ────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 250;
const BATCH_SIZE_CAP = 10;
const RETRY_BACKOFF_MS = 250;
/** Hard cap: never let a single batch exceed this many events. */
const MAX_BATCH = 100;

// ─── Types ─────────────────────────────────────────────────────────────────

export interface OutboundEvent {
  sequence: number;
  eventType: string;
  payload: unknown;
  agentMessageId?: string;
  durationMs?: number;
}

export interface EmitterDeps {
  /** HTTP poster — overridable for tests. */
  fetch?: typeof fetch;
  /** Returns the current epoch ms — overridable for tests. */
  now?: () => number;
}

interface PerJidState {
  taskId: string;
  queue: OutboundEvent[];
  /**
   * Monotonic intra-process counter, starts at 0 per JID.
   *
   * KNOWN GAP (architect concern A1, Port 4 review): on host restart the
   * counter resets to 0. If the new process emits events for the same
   * delegationId that's still alive in Postgres, the (delegationId, sequence)
   * unique constraint + `createMany skipDuplicates` will silently drop them.
   *
   * This is bounded in practice: agent runner usually restarts the delegation
   * (new id → no collision) when its host crashes mid-run. Long-lived
   * delegations across emitter restarts are rare today. Proper fix is a
   * BigInt sequence column (or an `instanceId` companion column in the
   * unique key), tracked as a follow-up.
   */
  sequenceCounter: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

// ─── Module state ──────────────────────────────────────────────────────────

const _state = new Map<string, PerJidState>();
let _deps: Required<EmitterDeps> = {
  fetch: globalThis.fetch,
  now: () => Date.now(),
};

/**
 * Test seam: replace fetch / now. Calling with `{}` resets to defaults.
 * Production code never calls this — it's purely for vitest.
 */
export function _setEmitterDepsForTests(deps: EmitterDeps): void {
  _deps = {
    fetch: deps.fetch ?? globalThis.fetch,
    now: deps.now ?? (() => Date.now()),
  };
}

/**
 * Test seam: drain everything synchronously. Used by event-emitter.test.ts
 * to force flushes without waiting 250ms in real time.
 */
export async function _flushAllForTests(): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const [jid, st] of _state.entries()) {
    if (st.flushTimer) {
      clearTimeout(st.flushTimer);
      st.flushTimer = null;
    }
    if (st.queue.length > 0) promises.push(flushOne(jid, st));
  }
  await Promise.all(promises);
}

export function _clearStateForTests(): void {
  for (const st of _state.values()) {
    if (st.flushTimer) clearTimeout(st.flushTimer);
  }
  _state.clear();
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Parse a chatJid of shape `delegate:task:<id>` and return the taskId.
 * Returns null for non-task JIDs (delegate:main, delegate:conv:*, etc.) —
 * those aren't tied to a delegation row, so we skip event emission for them.
 */
export function chatJidToTaskId(chatJid: string): string | null {
  const m = chatJid.match(/^delegate:task:(.+)$/);
  return m ? m[1] : null;
}

/**
 * Enqueue an event for a given chatJid. The event is buffered per JID and
 * flushed via the debounce/cap rule. No-op for non-task JIDs.
 */
export function enqueueEvent(
  chatJid: string,
  event: Omit<OutboundEvent, 'sequence'>,
): void {
  const taskId = chatJidToTaskId(chatJid);
  if (!taskId) return; // Only task JIDs map to delegations.

  let st = _state.get(chatJid);
  if (!st) {
    st = { taskId, queue: [], sequenceCounter: 0, flushTimer: null };
    _state.set(chatJid, st);
  }

  st.queue.push({ ...event, sequence: st.sequenceCounter++ });

  if (st.queue.length >= BATCH_SIZE_CAP) {
    if (st.flushTimer) {
      clearTimeout(st.flushTimer);
      st.flushTimer = null;
    }
    void flushOne(chatJid, st);
    return;
  }

  if (!st.flushTimer) {
    st.flushTimer = setTimeout(() => {
      const cur = _state.get(chatJid);
      if (cur) cur.flushTimer = null;
      if (cur) void flushOne(chatJid, cur);
    }, DEBOUNCE_MS);
    if (typeof (st.flushTimer as { unref?: () => void }).unref === 'function') {
      (st.flushTimer as { unref: () => void }).unref();
    }
  }
}

// ─── Internal: flush + retry ───────────────────────────────────────────────

async function flushOne(chatJid: string, st: PerJidState): Promise<void> {
  if (st.queue.length === 0) return;
  const batch = st.queue.splice(0, MAX_BATCH);
  await postBatch(st.taskId, batch).catch((err) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), chatJid, count: batch.length },
      'event-emitter post failed (after retry); dropping batch',
    );
  });
}

async function postBatch(taskId: string, events: OutboundEvent[]): Promise<void> {
  const baseUrl = process.env.DELEGATE_URL || 'https://delegate.ws';
  const token = getEnvWithFallback('DELEGATE_AGENT_TOKEN', ['DELEGATE_API_KEY']) || '';
  if (!token) {
    // Surface once-per-attempt, never throw — the agent must keep working.
    logger.debug('event-emitter: no DELEGATE_AGENT_TOKEN, skipping POST');
    return;
  }

  const body = JSON.stringify({ taskId, events });

  try {
    const ok = await tryPost(baseUrl, token, body);
    if (ok) return;
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'event-emitter first attempt failed; retrying',
    );
  }

  // One retry after backoff.
  await new Promise<void>((r) => setTimeout(r, RETRY_BACKOFF_MS));
  try {
    const ok = await tryPost(baseUrl, token, body);
    if (!ok) throw new Error('non-2xx response on retry');
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
}

async function tryPost(baseUrl: string, token: string, body: string): Promise<boolean> {
  const res = await _deps.fetch(`${baseUrl}/api/agent/channel/event`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body,
  });
  return res.ok;
}
