// ─── Delegate Channel for DelegateAgent ───
// Implements the DelegateAgent Channel interface to connect to Delegate's
// task, conversation, and agent-scoped messaging system.
//
// JID format:
//   delegate:task:<taskId>
//   delegate:conv:<convId>
//   delegate:agent:<agentUserId>
//
// Auth: Bearer token (DELEGATE_AGENT_TOKEN env var; DELEGATE_API_KEY accepted
// as a deprecated fallback for one release window).
//
// This file ships as src/channels/delegate.ts in the DelegateAgent repo
// (fork of upstream DelegateAgent). Before the rebrand it was injected into
// upstream DelegateAgent at deploy time via cloud-init.

import * as fs from 'fs';
import * as path from 'path';
import { registerChannel, type ChannelOpts } from './registry.js';
import type { Channel } from '../types.js';
import { dispatchChatFastPath } from '../chat/index.js';
import { getEnvWithFallback } from '../config.js';
import { fetchWithRetry5xx } from '../retry-fetch.js';
import { agentFetch } from '../delegate-fetch.js';
import { mintAgentJWT } from '../jwt-mint.js';
import {
  recordChannelPollError,
  recordChannelMessageDelivered,
} from '../metrics.js';

const POLL_INTERVAL = parseInt(
  process.env.DELEGATE_POLL_INTERVAL || '15000',
  10,
);
const DELEGATE_URL = (
  process.env.DELEGATE_URL || 'https://delegate.ws'
).replace(/\/$/, '');
// Canonical: DELEGATE_AGENT_TOKEN. Legacy fallback: DELEGATE_API_KEY (will be
// removed after the next release window — agents using only the legacy var
// will trip a deprecation warning at startup via getEnvWithFallback).
const DELEGATE_AGENT_TOKEN =
  // Accept NANOCLAW_TOKEN as a final legacy fallback so pre-rebrand droplets
  // (which have NANOCLAW_TOKEN in .env but not DELEGATE_AGENT_TOKEN or
  // DELEGATE_API_KEY) keep their delegate channel connected without a manual
  // .env edit. This mirrors the alias list in group-api.ts.
  getEnvWithFallback('DELEGATE_AGENT_TOKEN', [
    'DELEGATE_API_KEY',
    'NANOCLAW_TOKEN',
  ]) || '';

const CURSOR_FILE_PATH =
  process.env.DELEGATE_CURSOR_PATH ||
  '/opt/delegate-agent/data/delegate-cursors.json';
const CURSOR_SAVE_DEBOUNCE_MS = 10_000; // Write at most every 10s
const CURSOR_STALENESS_MS = 60 * 60 * 1000; // 1 hour — ignore cursor files older than this
const SEEN_IDS_CAP = 200; // Reduced from 2000 for file storage efficiency

/** Sentinel stored in `pollers` while a JID is waiting out its jitter delay
 * (the first poll hasn't fired yet, so there's no interval handle). Lets
 * `pollers.has(jid)` / `stopPoll(jid)` treat the JID as "polling" during the
 * delay so groupSync doesn't double-arm it. */
const JITTER_PENDING = 'jitter-pending' as const;
type PollerSlot = ReturnType<typeof setInterval> | typeof JITTER_PENDING;

interface CursorStore {
  cursors: Record<string, string>; // jid -> lastSeen ISO timestamp
  seenIds: Record<string, string[]>; // jid -> last 200 message IDs
  updatedAt: string; // ISO timestamp of last write
}

// ─── Sentry (optional — available when @sentry/node is installed) ────────────

let Sentry: any = null;
try {
  Sentry = (globalThis as any).__SENTRY__ || require('@sentry/node');
} catch {
  // @sentry/node not installed — errors will only go to console
}

function captureSentryError(err: unknown, context: Record<string, string>) {
  if (!Sentry) return;
  Sentry.withScope((scope: any) => {
    scope.setTag('component', 'delegate-agent-channel');
    for (const [k, v] of Object.entries(context)) scope.setTag(k, v);
    Sentry.captureException(err);
  });
}

function sentryBreadcrumb(message: string, data?: Record<string, unknown>) {
  if (!Sentry) return;
  Sentry.addBreadcrumb({
    category: 'delegate-agent',
    message,
    data,
    level: 'info',
  });
}

// ─── Sentry Cron Monitor (heartbeat — alerts when polling stops) ─────────────

const CRON_SLUG = 'delegate-agent-poll';
let cronCheckinId: string | null = null;

function cronCheckIn(status: 'in_progress' | 'ok' | 'error') {
  if (!Sentry?.captureCheckIn) return;
  try {
    if (status === 'in_progress') {
      cronCheckinId = Sentry.captureCheckIn(
        {
          monitorSlug: CRON_SLUG,
          status,
        },
        {
          schedule: { type: 'interval', value: 30, unit: 'second' },
          checkinMargin: 10,
          maxRuntime: 30,
          timezone: 'UTC',
        },
      );
    } else if (cronCheckinId) {
      Sentry.captureCheckIn({
        checkInId: cronCheckinId,
        monitorSlug: CRON_SLUG,
        status,
      });
      cronCheckinId = null;
    }
  } catch {
    // Cron API may not be available on all Sentry plans
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface PollMessage {
  id: string;
  text: string;
  role: string; // 'user' | 'assistant' | 'system'
  sender?: string; // display name / email
  timestamp: string; // ISO-8601
  isAI: boolean;
  /**
   * Phase 5 (credential-mode-toggle plan): Delegate user id whose credentials
   * should be used when the agent dispatches this message. Maps to:
   *   - delegate:task:<id>  → task.userId / AgentMessage.userId
   *   - delegate:conv:<id>  → Conversation.userId
   *   - delegate:agent:<id> → AgentProfile.userId / AgentMessage.userId
   *   - delegate:main       → AgentMessage.userId
   * Optional for back-compat with older Delegate deploys that don't emit it.
   */
  requestingUserId?: string;
  /**
   * Phase 4.3 of `.omc/plans/stuck-delegation-spawn-failure.md`: the Delegate
   * `TaskDelegation.id` this message belongs to, when known. Surfaced as a
   * top-level field by the channel poll route from `agent_messages.metadata
   * .delegationId`. Plumbed through `NewMessage.delegation_id` → `runAgent`
   * → `runContainerAgent` → `ContainerInput.delegationId` → in-container
   * heartbeat poster. Optional for back-compat.
   */
  delegationId?: string;
  /**
   * Phase 0 of `.omc/plans/agent-path-credential-failover.md`: the Delegate
   * workspace this message belongs to, emitted by platform poll-handler.ts
   * for all 4 JID branches. When present, used as the primary workspaceId
   * for chat fast-path credential resolution. When absent (legacy platform
   * deploys), gateway falls back to deriving via `/api/agent/context/[taskId]`
   * for task JIDs only. Optional + nullable for back-compat.
   */
  workspaceId?: string | null;
}

interface PollResponse {
  messages: PollMessage[];
}

// ─── Channel ─────────────────────────────────────────────────────────────────

export class DelegateChannel implements Channel {
  name = 'delegate';

  private opts: ChannelOpts;
  private pollers = new Map<string, PollerSlot>();
  /** Pending jitter-delay timers per JID (cleared on stopPoll / disconnect) */
  private jitterTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Last-seen ISO timestamp per JID — used as the `since` cursor */
  private lastSeen = new Map<string, string>();
  /** Deduplication: set of message IDs we have already routed */
  private seenIds = new Map<string, Set<string>>();
  /** JID → agentProfileId, populated from group metadata during connect() */
  private agentProfileIds = new Map<string, string>();
  /**
   * Phase 4 (agent-system-consolidation): latest known delegation ID per JID.
   * Forwarded as x-delegation-id header on every poll so the poll handler can
   * bump lastHeartbeatAt as a side-effect — replacing the container-side
   * setInterval heartbeat poster. Populated from msg.delegationId each time a
   * message is received that carries one; cleared when delegation completes.
   */
  private activeDelegationIds = new Map<string, string>();
  /**
   * JWT migration: latest known workspaceId per JID, populated from
   * msg.workspaceId during poll. Used by sendMessage/notifyTerminal/
   * notifyFailure/forwardProgressEvents to mint per-workspace JWTs via
   * agentFetch (falls back to legacy bearer when absent).
   */
  private workspaceIds = new Map<string, string>();
  private connected = false;
  /** Consecutive poll failure count per JID — for Sentry throttling */
  private pollFailures = new Map<string, number>();
  /** Interval that checks for dynamically registered groups */
  private groupSyncInterval: NodeJS.Timeout | null = null;
  /** Cron heartbeat — fires every 30s to signal poll loop is alive */
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  /** Debounced cursor save timer */
  private cursorSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Track messages delivered for metrics */
  private messagesDelivered = 0;
  private repliesSent = 0;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  // ─── Channel interface ────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (!DELEGATE_AGENT_TOKEN) {
      console.log('[delegate] No DELEGATE_AGENT_TOKEN set — channel disabled');
      return;
    }

    // Try to restore cursors from file
    const restored = this.loadCursors();
    if (restored) {
      for (const [jid, cursor] of Object.entries(restored.cursors)) {
        this.lastSeen.set(jid, cursor);
      }
      for (const [jid, ids] of Object.entries(restored.seenIds)) {
        this.seenIds.set(jid, new Set(ids));
      }
      console.log(
        `[delegate-channel] Restored cursors for ${Object.keys(restored.cursors).length} JIDs from file`,
      );
    }

    const groups = this.opts.registeredGroups();
    let started = 0;

    for (const [jid, meta] of Object.entries(groups)) {
      if (!this.ownsJid(jid)) continue;

      // Capture agentProfileId from group containerConfig if present
      const extra = (meta.containerConfig as any)?.agentProfileId;
      if (typeof extra === 'string' && extra) {
        this.agentProfileIds.set(jid, extra);
      }

      this.startPoll(jid);
      started++;
    }

    this.connected = true;

    // Listen for dynamic group registration (POST /api/groups at runtime)
    // DelegateAgent's registerGroup() doesn't notify channels, so we poll for
    // new groups on a slow interval and start polling any new delegate: JIDs.
    this.groupSyncInterval = setInterval(() => {
      try {
        const currentGroups = this.opts.registeredGroups();
        for (const [jid] of Object.entries(currentGroups)) {
          if (!this.ownsJid(jid)) continue;
          if (this.pollers.has(jid)) continue; // already polling
          // New group registered at runtime — start polling it
          const meta = (currentGroups as any)[jid];
          const extra = meta?.containerConfig?.agentProfileId;
          if (typeof extra === 'string' && extra) {
            this.agentProfileIds.set(jid, extra);
          }
          this.startPoll(jid);
          console.log(`[delegate] Dynamic group detected — now polling ${jid}`);
        }

        // Disarm pass: stop polling any JID that has disappeared from the
        // registry. This is how terminal-task deregister propagates — Delegate
        // DELETEs delegate:task:<id> (on terminal status or via prune), the
        // group-API drops it from the in-memory map, and within one sync cycle
        // (~10s) we stop its poller and free its per-JID state. Without this the
        // registry could only ever grow, which is exactly how 491 stale task
        // JIDs accumulated into the poll flood (2026-06-20). Always-on control
        // JIDs (delegate:main, delegate:agent:*) are never disarmed, even if a
        // transient registry read omits them.
        for (const jid of [...this.pollers.keys()]) {
          if (this.isAlwaysOnJid(jid)) continue;
          if (currentGroups[jid]) continue; // still registered
          this.stopPoll(jid);
          sentryBreadcrumb('channel.poll.deregistered', { jid });
          console.log(`[delegate] Group deregistered — stopped polling ${jid}`);
        }
      } catch {}
    }, 10_000); // Check every 10 seconds

    // Start heartbeat cron — Sentry alerts if this stops firing
    this.heartbeatInterval = setInterval(() => {
      cronCheckIn('in_progress');
      // Immediately complete — this is a heartbeat, not a long-running job
      setTimeout(() => cronCheckIn('ok'), 100);
    }, 30_000);

    sentryBreadcrumb('channel.connect', { jidCount: started });
    console.log(`[delegate] Channel connected — polling ${started} JID(s)`);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.ownsJid(jid)) return;

    const agentProfileId = this.agentProfileIds.get(jid);
    const startTime = Date.now();

    // ─── Parse and forward progress events ───
    const progressEvents = this.extractProgressEvents(text);
    if (progressEvents.length > 0) {
      this.forwardProgressEvents(jid, agentProfileId, progressEvents).catch(
        (err) =>
          console.warn(
            '[delegate] progress forward error:',
            (err as Error).message,
          ),
      );
    }

    // Strip progress tags from the user-visible message
    const cleanText = text
      .replace(/<progress[^>]*>[\s\S]*?<\/progress>/g, '')
      .trim();
    if (!cleanText) return; // Only progress events, no user-visible content

    try {
      const res = await agentFetch('/api/agent/channel/reply', {
        workspaceId: this.workspaceIds.get(jid),
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jid,
            text: cleanText,
            ...(agentProfileId ? { agentProfileId } : {}),
            metadata: { source: 'delegate-agent' },
          }),
          signal: AbortSignal.timeout(10_000),
        },
      });

      const latencyMs = Date.now() - startTime;

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        captureSentryError(
          new Error(`Reply HTTP ${res.status}: ${errText.slice(0, 200)}`),
          { jid, action: 'sendMessage' },
        );
        console.warn(
          `[delegate] Reply failed for ${jid}: HTTP ${res.status} (${latencyMs}ms)`,
        );
      } else {
        this.repliesSent++;
        sentryBreadcrumb('channel.reply', {
          jid,
          latencyMs,
          totalReplies: this.repliesSent,
        });
      }
    } catch (err: unknown) {
      captureSentryError(err, { jid, action: 'sendMessage' });
      console.warn('[delegate] sendMessage error:', (err as Error).message);
    }
  }

  /**
   * Notify Delegate that the agent emitted a terminal success/error signal in
   * its OUTPUT marker. This is the "I'm done" handshake — it lets the reply
   * route transition the delegation out of `running` even when the agent
   * didn't push a deliverable branch or call `task.complete` explicitly
   * (common for research / audit / Q&A tasks).
   *
   * Posts to the existing /api/agent/channel/reply endpoint with
   * `metadata.terminal: true` + `metadata.agentStatus`. The reply route
   * picks this up in its terminal-signal branch (text is optional in this
   * mode — the user-visible text was already delivered by the prior
   * sendMessage call).
   *
   * Fire-and-forget — never throws into the caller.
   */
  async notifyTerminal(
    jid: string,
    status: 'success' | 'error',
  ): Promise<void> {
    if (!this.ownsJid(jid)) return;
    if (!DELEGATE_AGENT_TOKEN) return;

    const agentProfileId = this.agentProfileIds.get(jid);
    const workspaceId = this.workspaceIds.get(jid);

    // Mint a per-workspace JWT; fall back to legacy bearer on failure.
    let bearer = DELEGATE_AGENT_TOKEN;
    if (workspaceId) {
      try {
        const minted = await mintAgentJWT({ workspaceId });
        if (minted) bearer = minted.jwt;
      } catch {
        /* fall back to legacy bearer */
      }
    }

    // 3-attempt retry on 5XX/network errors (Vercel cold start, transient DB
    // hiccup). Defense in depth alongside the Delegate-side Inngest fan-out
    // — the route itself can still 5XX during cold-isolate startup, and a
    // single lost signal stalls the delegation until the 5min reaper.
    const res = await fetchWithRetry5xx(
      `${DELEGATE_URL}/api/agent/channel/reply`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({
          jid,
          ...(agentProfileId ? { agentProfileId } : {}),
          metadata: {
            source: 'delegate-agent',
            terminal: true,
            agentStatus: status,
          },
        }),
        signal: AbortSignal.timeout(10_000),
      },
      { label: 'delegate.notifyTerminal' },
    );
    if (res && !res.ok && res.status !== 404) {
      // 404 = receiver hasn't deployed the terminal-signal branch yet —
      // tolerate gracefully so an older Delegate can ignore the call.
      const errText = await res.text().catch(() => '');
      console.warn(
        `[delegate] notifyTerminal failed for ${jid}: HTTP ${res.status} — ${errText.slice(0, 160)}`,
      );
    }
  }

  /**
   * Phase 5 (credential-mode-toggle plan): surface a non-retryable container
   * spawn failure back to Delegate so the task ticket displays the error.
   * Currently triggered when OAuth mode is configured but the token is missing
   * (`oauth_token_missing` — see container-runner's oauthHardFail short-circuit).
   *
   * Posts a system message tagged with the failure reason. The Delegate-side
   * reply handler stores it as an AgentMessage with role="system" and the
   * delegation state machine fails the task with `reason: "oauth_token_missing"`.
   *
   * Fire-and-forget; never throws into the caller.
   */
  async notifyFailure(
    jid: string,
    reason: string,
    detail?: string,
  ): Promise<void> {
    if (!this.ownsJid(jid)) return;
    if (!DELEGATE_AGENT_TOKEN) return;

    const agentProfileId = this.agentProfileIds.get(jid);
    try {
      const res = await agentFetch('/api/agent/channel/reply', {
        workspaceId: this.workspaceIds.get(jid),
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jid,
            ...(agentProfileId ? { agentProfileId } : {}),
            metadata: {
              source: 'delegate-agent',
              terminal: true,
              agentStatus: 'error',
              failureReason: reason,
              ...(detail ? { failureDetail: detail.slice(0, 500) } : {}),
            },
          }),
          signal: AbortSignal.timeout(10_000),
        },
      });
      if (!res.ok && res.status !== 404) {
        const errText = await res.text().catch(() => '');
        console.warn(
          `[delegate] notifyFailure failed for ${jid}: HTTP ${res.status} — ${errText.slice(0, 160)}`,
        );
      }
    } catch (err: unknown) {
      console.warn('[delegate] notifyFailure error:', (err as Error).message);
    }
  }

  // ─── Progress Event Extraction ──────────────────────────────────────────

  private extractProgressEvents(
    text: string,
  ): Array<{ type: string; data: Record<string, string>; message: string }> {
    const events: Array<{
      type: string;
      data: Record<string, string>;
      message: string;
    }> = [];
    const regex = /<progress\s+([^>]*)>([\s\S]*?)<\/progress>/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const attrs: Record<string, string> = {};
      const attrStr = match[1];
      const attrRegex = /(\w+)="([^"]*)"/g;
      let attrMatch;
      while ((attrMatch = attrRegex.exec(attrStr)) !== null) {
        attrs[attrMatch[1]] = attrMatch[2];
      }
      events.push({
        type: attrs.type || 'info',
        data: attrs,
        message: match[2].trim(),
      });
    }
    return events;
  }

  private async forwardProgressEvents(
    jid: string,
    agentProfileId: string | undefined,
    events: Array<{
      type: string;
      data: Record<string, string>;
      message: string;
    }>,
  ): Promise<void> {
    try {
      await agentFetch('/api/agent/channel/progress', {
        workspaceId: this.workspaceIds.get(jid),
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jid,
            ...(agentProfileId ? { agentProfileId } : {}),
            events,
          }),
          signal: AbortSignal.timeout(5_000),
        },
      });
    } catch {
      // Best-effort — don't fail the main message flow
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('delegate:');
  }

  /** Control JIDs that must never be disarmed by the groupSync disarm pass:
   * the aggregate main channel and per-agent solo channels. Only per-entity
   * JIDs (delegate:task:*, delegate:conv:*) are eligible for deregister. */
  private isAlwaysOnJid(jid: string): boolean {
    return jid === 'delegate:main' || jid.startsWith('delegate:agent:');
  }

  async disconnect(): Promise<void> {
    for (const slot of this.pollers.values()) {
      if (slot !== JITTER_PENDING) clearInterval(slot);
    }
    for (const t of this.jitterTimers.values()) {
      clearTimeout(t);
    }
    this.jitterTimers.clear();
    if (this.groupSyncInterval) {
      clearInterval(this.groupSyncInterval);
      this.groupSyncInterval = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    // Final cursor write before shutdown
    if (this.cursorSaveTimer) {
      clearTimeout(this.cursorSaveTimer);
      this.cursorSaveTimer = null;
    }
    this.writeCursors();
    this.pollers.clear();
    this.lastSeen.clear();
    this.seenIds.clear();
    this.pollFailures.clear();
    this.activeDelegationIds.clear();
    this.workspaceIds.clear();
    this.connected = false;
    sentryBreadcrumb('channel.disconnect', {
      messagesDelivered: this.messagesDelivered,
      repliesSent: this.repliesSent,
    });
    console.log('[delegate] Channel disconnected');
  }

  // setTyping is optional — stub only, Delegate does not surface typing state
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /** Load cursors from file if fresh enough, otherwise return null */
  private loadCursors(): CursorStore | null {
    try {
      if (!fs.existsSync(CURSOR_FILE_PATH)) return null;
      const raw = fs.readFileSync(CURSOR_FILE_PATH, 'utf-8');
      const store: CursorStore = JSON.parse(raw);
      const age = Date.now() - new Date(store.updatedAt).getTime();
      if (age > CURSOR_STALENESS_MS) return null; // Too old — start fresh
      return store;
    } catch {
      // Corrupt or unreadable — start fresh
      return null;
    }
  }

  /** Atomic write: temp file + rename to prevent corruption */
  private writeCursors(): void {
    try {
      const store: CursorStore = {
        cursors: Object.fromEntries(this.lastSeen),
        seenIds: Object.fromEntries(
          Array.from(this.seenIds.entries()).map(([jid, set]) => [
            jid,
            [...set].slice(-SEEN_IDS_CAP),
          ]),
        ),
        updatedAt: new Date().toISOString(),
      };
      const dir = path.dirname(CURSOR_FILE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmpPath = CURSOR_FILE_PATH + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2));
      fs.renameSync(tmpPath, CURSOR_FILE_PATH);
    } catch (err) {
      // Log but don't crash — persistence is best-effort
      console.error('[delegate-channel] Failed to write cursors:', err);
    }
  }

  /** Debounced cursor save — writes at most once every 10s */
  private scheduleCursorSave(): void {
    if (this.cursorSaveTimer) return; // Already scheduled
    this.cursorSaveTimer = setTimeout(() => {
      this.cursorSaveTimer = null;
      this.writeCursors();
    }, CURSOR_SAVE_DEBOUNCE_MS);
  }

  private startPoll(jid: string): void {
    if (this.pollers.has(jid)) return;

    // Only seed if not already restored from file.
    // Use epoch (not now) so the first poll fetches ALL messages — including any
    // that arrived before the JID was registered (the "first message race").
    // Existing JIDs loaded from delegate-cursors.json keep their persisted cursor.
    if (!this.lastSeen.has(jid)) {
      this.lastSeen.set(jid, new Date(0).toISOString());
    }
    if (!this.seenIds.has(jid)) {
      this.seenIds.set(jid, new Set());
    }
    this.pollFailures.set(jid, 0);

    // Jitter the steady-state poll phase: stagger the FIRST poll by a random
    // 0..POLL_INTERVAL offset, then settle into the regular interval. Without
    // this, every JID armed in the same connect()/groupSync tick fires in
    // lock-step, so N JIDs produce one sub-second burst of N requests every
    // cycle (the "poll slamming" shape, 2026-06-20). Spreading the first fire
    // smooths the request rate across the window. Set DELEGATE_POLL_JITTER=0 to
    // restore deterministic lock-step (useful for repro/tests).
    const jitterEnabled = process.env.DELEGATE_POLL_JITTER !== '0';
    const offset = jitterEnabled
      ? Math.floor(Math.random() * POLL_INTERVAL)
      : 0;

    const arm = (): void => {
      // Guard against a teardown that landed during the jitter delay.
      if (!this.pollers.has(jid) || this.pollers.get(jid) !== JITTER_PENDING) {
        return;
      }
      void this.poll(jid);
      const interval = setInterval(() => {
        void this.poll(jid);
      }, POLL_INTERVAL);
      this.pollers.set(jid, interval);
    };

    if (offset === 0) {
      const interval = setInterval(() => {
        void this.poll(jid);
      }, POLL_INTERVAL);
      this.pollers.set(jid, interval);
    } else {
      // Mark the slot as pending so stopPoll() and has()-checks treat the JID as
      // "polling" during the jitter delay (prevents a duplicate arm from groupSync).
      this.pollers.set(jid, JITTER_PENDING);
      const t = setTimeout(arm, offset);
      this.jitterTimers.set(jid, t);
    }
  }

  /** Stop polling a JID and drop all its per-JID state. Called by the groupSync
   * disarm pass when a JID disappears from the registry (terminal-task
   * deregister via DELETE /api/groups/:jid, 2026-06-20). Idempotent. */
  private stopPoll(jid: string): void {
    const slot = this.pollers.get(jid);
    if (slot && slot !== JITTER_PENDING) {
      clearInterval(slot);
    }
    this.pollers.delete(jid);
    const jt = this.jitterTimers.get(jid);
    if (jt) {
      clearTimeout(jt);
      this.jitterTimers.delete(jid);
    }
    this.lastSeen.delete(jid);
    this.seenIds.delete(jid);
    this.pollFailures.delete(jid);
    this.agentProfileIds.delete(jid);
    this.activeDelegationIds.delete(jid);
    this.workspaceIds.delete(jid);
    this.scheduleCursorSave();
  }

  private async poll(jid: string): Promise<void> {
    const since = this.lastSeen.get(jid) ?? new Date().toISOString();
    const seen = this.seenIds.get(jid)!;
    const startTime = Date.now();

    const pollPath =
      `/api/agent/channel/poll` +
      `?jid=${encodeURIComponent(jid)}` +
      `&since=${encodeURIComponent(since)}` +
      `&limit=20`;

    // Phase 4 (agent-system-consolidation): include active delegation ID as
    // x-delegation-id header so the poll handler bumps lastHeartbeatAt as a
    // side-effect — replacing the container-side setInterval heartbeat poster.
    // JWT migration: extra headers (x-delegation-id) are merged; Authorization
    // is injected by agentFetch using the per-workspace JWT (falls back to
    // legacy DELEGATE_AGENT_TOKEN if no workspaceId or mint fails).
    const extraPollHeaders: Record<string, string> = {};
    const activeDelegationId = this.activeDelegationIds.get(jid);
    if (activeDelegationId) {
      extraPollHeaders['x-delegation-id'] = activeDelegationId;
    }

    let data: PollResponse;
    try {
      const res = await agentFetch(pollPath, {
        workspaceId: this.workspaceIds.get(jid),
        init: {
          headers: extraPollHeaders,
          signal: AbortSignal.timeout(5_000),
        },
      });

      if (!res.ok) {
        const failures = (this.pollFailures.get(jid) ?? 0) + 1;
        this.pollFailures.set(jid, failures);
        const kind = res.status >= 500 ? 'http_5xx' : 'http_4xx';
        recordChannelPollError('delegate', kind);
        if (failures === 1 || failures % 100 === 0) {
          captureSentryError(new Error(`Poll HTTP ${res.status}`), {
            jid,
            action: 'poll',
            failures: String(failures),
          });
        }
        console.warn(`[delegate] Poll HTTP ${res.status} for ${jid}`);
        return;
      }

      // Reset failure counter on success
      this.pollFailures.set(jid, 0);
      data = (await res.json()) as PollResponse;
    } catch (err: unknown) {
      const failures = (this.pollFailures.get(jid) ?? 0) + 1;
      this.pollFailures.set(jid, failures);
      const errName = (err as Error)?.name;
      const errKind: 'timeout' | 'parse' | 'network' =
        errName === 'AbortError' || errName === 'TimeoutError'
          ? 'timeout'
          : err instanceof SyntaxError
            ? 'parse'
            : 'network';
      recordChannelPollError('delegate', errKind);
      if (failures === 5 || failures % 100 === 0) {
        captureSentryError(err, {
          jid,
          action: 'poll',
          failures: String(failures),
        });
      }
      return;
    }

    const messages = data.messages ?? [];
    if (messages.length === 0) return;

    const latencyMs = Date.now() - startTime;

    // Advance the since cursor to the newest message timestamp
    const latest = messages[messages.length - 1].timestamp;
    if (latest > since) {
      this.lastSeen.set(jid, latest);
      this.scheduleCursorSave();
    }

    let delivered = 0;
    for (const msg of messages) {
      // Skip AI/agent messages (our own replies) and already-seen messages
      if (msg.isAI) continue;
      if (seen.has(msg.id)) continue;

      seen.add(msg.id);

      // Keep the deduplication set from growing unboundedly
      if (seen.size > SEEN_IDS_CAP) {
        const first = seen.values().next().value;
        if (first !== undefined) seen.delete(first);
      }

      // Phase 4 (agent-system-consolidation): track the latest delegation ID
      // for this JID so future polls include x-delegation-id header, enabling
      // the poll handler's heartbeat side-effect. Safe to update on every
      // message — the delegation ID is stable for the run duration.
      if (msg.delegationId) {
        this.activeDelegationIds.set(jid, msg.delegationId);
      }

      // JWT migration: cache workspaceId per JID for use in outbound calls.
      if (msg.workspaceId) {
        this.workspaceIds.set(jid, msg.workspaceId);
      }

      // ── Chat fast-path ────────────────────────────────────────────────
      // Mirrors openclaw's auto-reply/dispatch pattern: try a lightweight
      // direct-to-Bifrost reply for short conversational messages, fall
      // through to the heavy container path on skip / error.
      // Fire-and-forget per message — the inner await keeps semantic order
      // for ONE message but the loop doesn't block other messages.
      const inboundForChat = {
        jid,
        text: typeof msg.text === 'string' ? msg.text : '',
        senderName: msg.sender ?? msg.role ?? 'User',
        // Phase 0 of agent-path-credential-failover plan: forward the
        // platform-emitted workspaceId + requesting user id so the chat
        // fast-path can resolve per-workspace credentials. Both optional —
        // gateway falls back gracefully when absent.
        workspaceId: msg.workspaceId ?? null,
        requestingUserId: msg.requestingUserId,
      };

      // Task-JID hard gate — per memory `feedback_chat_fastpath_not_for_agent_execution`:
      // task JIDs MUST always go to the container path (BMAD prompt + skills +
      // MCP server + tools). The chat fast-path is for conversational JIDs only
      // (delegate:conv:*, delegate:agent:*, delegate:main, channel-native JIDs
      // from WhatsApp/Telegram/etc).
      //
      // Also gate on msg.delegationId — any inbound that already carries an
      // in-flight TaskDelegation belongs to the container path regardless of JID
      // shape (defensive against legacy or aliased JIDs).
      //
      // Contract change from previous behaviour: previously a task JID with a
      // short/ambiguous text (e.g. "hi") could be routed to the Bifrost direct
      // path by classifyForFastPath(). That round-trip bypassed the container,
      // BMAD stage prompt, and tools. This gate closes that gap entirely with
      // zero Bifrost latency cost for task JIDs.
      const isTaskJid = jid.startsWith('delegate:task:');
      const hasDelegationId = Boolean(msg.delegationId);
      if (isTaskJid || hasDelegationId) {
        sentryBreadcrumb('chat.fastpath.gated', {
          jid,
          reason: isTaskJid
            ? 'task-jid-no-fastpath'
            : 'delegation-id-no-fastpath',
          delegationId: msg.delegationId ?? null,
        });
        // Hand off directly to container path (same shape as the post-fastpath
        // fall-through below). DO NOT call dispatchChatFastPath at all —
        // zero Bifrost round-trip for task JIDs.
        recordChannelMessageDelivered('delegate');
        this.opts.onMessage(jid, {
          id: msg.id,
          chat_jid: jid,
          sender: msg.sender ?? msg.role ?? 'user',
          sender_name: msg.sender ?? msg.role ?? 'User',
          content: msg.text,
          timestamp: msg.timestamp,
          is_from_me: false,
          is_bot_message: false,
          requesting_user_id: msg.requestingUserId,
          delegation_id: msg.delegationId,
        });
        delivered++;
        continue; // skip rest of loop iteration — fastpath not called
      }

      void dispatchChatFastPath(inboundForChat).then(async (result) => {
        if (result.handled) {
          console.log(
            `[chat] fastpath handled jid=${jid} latency=${result.latencyMs}ms model=${result.model} replyLen=${result.replyText.length}`,
          );
          sentryBreadcrumb('chat.fastpath.handled', {
            jid,
            latencyMs: result.latencyMs,
            model: result.model,
            replyLen: result.replyText.length,
          });
          try {
            await this.sendMessage(jid, result.replyText);
            console.log(`[chat] fastpath reply sent jid=${jid}`);
          } catch (err) {
            console.warn(
              `[chat] fastpath reply error jid=${jid}:`,
              (err as Error).message,
            );
            captureSentryError(err, { jid, action: 'chat-fastpath-reply' });
          }
          return;
        }

        console.log(
          `[chat] fastpath skip jid=${jid} reason=${result.reason} textLen=${inboundForChat.text.length}`,
        );
        sentryBreadcrumb('chat.fastpath.skipped', {
          jid,
          reason: result.reason,
          textLen: inboundForChat.text.length,
        });
        // Plan §5 Phase 5.3 semantics: `credentials-failure` is the only
        // skip reason that does NOT fall through to the container. Container
        // would resolve the same exhausted credential — fall-through adds
        // latency without recovering. Surface the user-visible error
        // directly and short-circuit.
        if (result.reason === 'credentials-failure') {
          const userMsg =
            result.userMessage ??
            'Workspace LLM credits exhausted — contact admin';
          try {
            await this.sendMessage(jid, userMsg);
            console.log(
              `[chat] fastpath credentials-failure surfaced jid=${jid}`,
            );
          } catch (err) {
            console.warn(
              `[chat] fastpath credentials-failure send error jid=${jid}:`,
              (err as Error).message,
            );
            captureSentryError(err, {
              jid,
              action: 'chat-fastpath-credentials-failure',
            });
          }
          return;
        }
        // Route to DelegateAgent orchestrator (NewMessage format) — only
        // when fast-path doesn't handle it. bifrost-error and
        // oauth-mode-container-only intentionally fall through (container
        // can resolve the OAuth case correctly; bifrost-error retries the
        // full path).
        recordChannelMessageDelivered('delegate');
        this.opts.onMessage(jid, {
          id: msg.id,
          chat_jid: jid,
          sender: msg.sender ?? msg.role ?? 'user',
          sender_name: msg.sender ?? msg.role ?? 'User',
          content: msg.text,
          timestamp: msg.timestamp,
          is_from_me: false,
          is_bot_message: false,
          // Phase 5: surface the Delegate user id so the orchestrator can
          // route per-user OAuth credential resolution in the container.
          requesting_user_id: msg.requestingUserId,
          // Phase 4.3: surface the in-flight TaskDelegation.id (Bug D — Phase 4
          // of .omc/plans/stuck-delegation-spawn-failure.md). The orchestrator
          // plumbs this through to runContainerAgent → ContainerInput so the
          // in-container agent-runner can POST /api/agent/heartbeat every 60s.
          delegation_id: msg.delegationId,
        });
      });
      delivered++;
    }

    if (delivered > 0) {
      this.messagesDelivered += delivered;
      sentryBreadcrumb('channel.poll.delivered', {
        jid,
        delivered,
        latencyMs,
        totalDelivered: this.messagesDelivered,
      });
    }
  }
}

// ─── Chat fastpath context resolver ─────────────────────────────────────
// Plumbs per-JID workspace-user Anthropic OAuth tokens into the chat
// fastpath's Tier 1 (Anthropic-direct) failover. Cached in-memory for
// 5 minutes per JID to avoid hitting the endpoint on every reply.
//
// The endpoint runs the 4-tier picker (personal user → workspace default →
// system → none) and returns the OAuth token if the winning tier is OAuth.
// Falls back to null silently — chat fastpath then goes straight to Tier 2
// (Bifrost gateway).
import { setChatContextResolver } from '../chat/index.js';

const CHAT_CRED_CACHE_TTL_MS = 5 * 60_000;
const chatCredCache = new Map<
  string,
  { oauthToken: string | null; expiresAt: number }
>();

async function resolveChatFastpathCreds(
  jid: string,
): Promise<{ system: string; oauthToken: string | null } | null> {
  const now = Date.now();
  const cached = chatCredCache.get(jid);
  let oauthToken: string | null = null;
  if (cached && cached.expiresAt > now) {
    oauthToken = cached.oauthToken;
  } else if (DELEGATE_AGENT_TOKEN) {
    try {
      // JWT migration: agentFetch mints a per-workspace JWT when workspaceId
      // is available. For this helper the JID is module-scoped — no per-JID
      // workspaceId is in scope here, so we pass undefined and let agentFetch
      // fall back to legacy DELEGATE_AGENT_TOKEN bearer automatically.
      const res = await agentFetch(
        `/api/agent/chat-fastpath-credentials?jid=${encodeURIComponent(jid)}`,
        { init: { signal: AbortSignal.timeout(3000) } },
      );
      if (res.ok) {
        const data = (await res.json()) as {
          data?: { oauthToken?: string | null };
        };
        oauthToken = data?.data?.oauthToken ?? null;
        chatCredCache.set(jid, {
          oauthToken,
          expiresAt: now + CHAT_CRED_CACHE_TTL_MS,
        });
      }
    } catch (err) {
      // Resolver is best-effort — fall back to gateway-only on failure.
      console.warn(
        `[chat-fastpath-creds] resolution failed for ${jid}: ${(err as Error).message}`,
      );
    }
  }

  // System prompt is left empty here — the existing inline preamble in the
  // poll-handler-wrapped user message provides task context. Future versions
  // may upgrade this to fetch task title/description for a richer system.
  return { system: '', oauthToken };
}

// ─── Self-register at module load (DelegateAgent barrel-import pattern) ─────

setChatContextResolver(resolveChatFastpathCreds);

registerChannel('delegate', (opts: ChannelOpts) => {
  if (!DELEGATE_AGENT_TOKEN) {
    console.log('[delegate] Skipped: DELEGATE_AGENT_TOKEN not set');
    return null;
  }
  return new DelegateChannel(opts);
});
