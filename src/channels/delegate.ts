// ─── Delegate Channel for DelegateAgent ───
// Implements the DelegateAgent Channel interface to connect to Delegate's
// task, conversation, and agent-scoped messaging system.
//
// JID format:
//   delegate:task:<taskId>
//   delegate:conv:<convId>
//   delegate:agent:<agentUserId>
//
// Auth: Bearer token (DELEGATE_API_KEY env var)
//
// This file ships as src/channels/delegate.ts in the DelegateAgent repo
// (fork of upstream NanoClaw). Before the rebrand it was injected into
// upstream NanoClaw at deploy time via cloud-init.

import * as fs from 'fs';
import * as path from 'path';
import { registerChannel, type ChannelOpts } from './registry.js';
import type { Channel } from '../types.js';

const POLL_INTERVAL = parseInt(
  process.env.DELEGATE_POLL_INTERVAL || '15000',
  10,
);
const DELEGATE_URL = (
  process.env.DELEGATE_URL || 'https://delegate.ws'
).replace(/\/$/, '');
const DELEGATE_API_KEY = process.env.DELEGATE_API_KEY || '';

const CURSOR_FILE_PATH =
  process.env.DELEGATE_CURSOR_PATH ||
  '/opt/delegate-agent/data/delegate-cursors.json';
const CURSOR_SAVE_DEBOUNCE_MS = 10_000; // Write at most every 10s
const CURSOR_STALENESS_MS = 60 * 60 * 1000; // 1 hour — ignore cursor files older than this
const SEEN_IDS_CAP = 200; // Reduced from 2000 for file storage efficiency

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
    scope.setTag('component', 'nanoclaw-channel');
    for (const [k, v] of Object.entries(context)) scope.setTag(k, v);
    Sentry.captureException(err);
  });
}

function sentryBreadcrumb(message: string, data?: Record<string, unknown>) {
  if (!Sentry) return;
  Sentry.addBreadcrumb({ category: 'nanoclaw', message, data, level: 'info' });
}

// ─── Sentry Cron Monitor (heartbeat — alerts when polling stops) ─────────────

const CRON_SLUG = 'nanoclaw-delegate-poll';
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
}

interface PollResponse {
  messages: PollMessage[];
}

// ─── Channel ─────────────────────────────────────────────────────────────────

class DelegateChannel implements Channel {
  name = 'delegate';

  private opts: ChannelOpts;
  private pollers = new Map<string, ReturnType<typeof setInterval>>();
  /** Last-seen ISO timestamp per JID — used as the `since` cursor */
  private lastSeen = new Map<string, string>();
  /** Deduplication: set of message IDs we have already routed */
  private seenIds = new Map<string, Set<string>>();
  /** JID → agentProfileId, populated from group metadata during connect() */
  private agentProfileIds = new Map<string, string>();
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
    if (!DELEGATE_API_KEY) {
      console.log('[delegate] No DELEGATE_API_KEY set — channel disabled');
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
      const res = await fetch(`${DELEGATE_URL}/api/agent/channel/reply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DELEGATE_API_KEY}`,
        },
        body: JSON.stringify({
          jid,
          text: cleanText,
          ...(agentProfileId ? { agentProfileId } : {}),
          metadata: { source: 'nanoclaw' },
        }),
        signal: AbortSignal.timeout(10_000),
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
      await fetch(`${DELEGATE_URL}/api/agent/channel/progress`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DELEGATE_API_KEY}`,
        },
        body: JSON.stringify({
          jid,
          ...(agentProfileId ? { agentProfileId } : {}),
          events,
        }),
        signal: AbortSignal.timeout(5_000),
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

  async disconnect(): Promise<void> {
    for (const interval of this.pollers.values()) {
      clearInterval(interval);
    }
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

    // Only seed if not already restored from file
    if (!this.lastSeen.has(jid)) {
      this.lastSeen.set(jid, new Date().toISOString());
    }
    if (!this.seenIds.has(jid)) {
      this.seenIds.set(jid, new Set());
    }
    this.pollFailures.set(jid, 0);

    const interval = setInterval(() => {
      void this.poll(jid);
    }, POLL_INTERVAL);

    this.pollers.set(jid, interval);
  }

  private async poll(jid: string): Promise<void> {
    const since = this.lastSeen.get(jid) ?? new Date().toISOString();
    const seen = this.seenIds.get(jid)!;
    const startTime = Date.now();

    const url =
      `${DELEGATE_URL}/api/agent/channel/poll` +
      `?jid=${encodeURIComponent(jid)}` +
      `&since=${encodeURIComponent(since)}` +
      `&limit=20`;

    let data: PollResponse;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${DELEGATE_API_KEY}` },
        signal: AbortSignal.timeout(5_000),
      });

      if (!res.ok) {
        const failures = (this.pollFailures.get(jid) ?? 0) + 1;
        this.pollFailures.set(jid, failures);
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

      // Route to DelegateAgent orchestrator (NewMessage format)
      this.opts.onMessage(jid, {
        id: msg.id,
        chat_jid: jid,
        sender: msg.sender ?? msg.role ?? 'user',
        sender_name: msg.sender ?? msg.role ?? 'User',
        content: msg.text,
        timestamp: msg.timestamp,
        is_from_me: false,
        is_bot_message: false,
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

// ─── Self-register at module load (DelegateAgent barrel-import pattern) ─────

registerChannel('delegate', (opts: ChannelOpts) => {
  if (!DELEGATE_API_KEY) {
    console.log('[delegate] Skipped: DELEGATE_API_KEY not set');
    return null;
  }
  return new DelegateChannel(opts);
});
