/**
 * metrics.ts — Prometheus metrics for DelegateAgent.
 *
 * Uses a dedicated Registry (never the prom-client default/global registry) so
 * this module is safe to hot-reload under `tsx --watch` without double-register
 * errors. Every public function routes through safeMetric() so a buggy counter
 * never crashes the host process. jid_kind cardinality is bounded: only the
 * 10 known variants in JidKind are emitted; unknown JIDs collapse to 'unknown'.
 */

import {
  Registry,
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
} from 'prom-client';
import type { IncomingMessage, ServerResponse } from 'http';
import { logger } from './logger.js';

// ─── Registry ────────────────────────────────────────────────────────────────

export const metricsRegistry = new Registry();

// Hot-reload safety: tsx --watch re-imports modules in the same process, which
// would cause "metric already registered" errors on the second import. Clearing
// before construction avoids that in dev without affecting production.
if (process.env.NODE_ENV !== 'production') {
  metricsRegistry.clear();
}

collectDefaultMetrics({
  register: metricsRegistry,
  prefix: 'delegate_agent_node_',
});

// ─── JID kind ────────────────────────────────────────────────────────────────

export type JidKind =
  | 'main'
  | 'delegate_task'
  | 'delegate_conv'
  | 'delegate_agent'
  | 'whatsapp'
  | 'telegram'
  | 'slack'
  | 'discord'
  | 'gmail'
  | 'unknown';

const _seenUnknownPrefixes = new Set<string>();

export function jidKind(jid: string): JidKind {
  if (jid === 'main') return 'main';
  if (jid.startsWith('delegate:task:')) return 'delegate_task';
  if (jid.startsWith('delegate:conv:')) return 'delegate_conv';
  if (jid.startsWith('delegate:agent:')) return 'delegate_agent';
  if (
    jid.startsWith('whatsapp:') ||
    jid.endsWith('@s.whatsapp.net') ||
    jid.endsWith('@g.us')
  )
    return 'whatsapp';
  if (jid.startsWith('telegram:') || jid.startsWith('tg:')) return 'telegram';
  if (jid.startsWith('slack:')) return 'slack';
  if (jid.startsWith('discord:') || jid.startsWith('dc:')) return 'discord';
  if (jid.startsWith('gmail:')) return 'gmail';

  // Emit a single warning per unrecognised prefix per process lifetime.
  const prefix = jid.split(':')[0] ?? jid;
  if (!_seenUnknownPrefixes.has(prefix)) {
    _seenUnknownPrefixes.add(prefix);
    logger.warn(
      { jid, prefix },
      'jidKind: unrecognised JID prefix, classifying as unknown',
    );
  }
  return 'unknown';
}

// ─── safeMetric helper ───────────────────────────────────────────────────────

function safeMetric(fn: () => void): void {
  if (process.env.DELEGATE_AGENT_METRICS_DISABLED === '1') return;
  try {
    fn();
  } catch (err) {
    logger.warn({ err }, 'metric emission failed');
  }
}

// ─── Metric definitions ──────────────────────────────────────────────────────

const DURATION_BUCKETS = [0.5, 2, 5, 15, 60, 300, 900, 1800, 3600];

const containerSpawnedTotal = new Counter({
  name: 'delegate_agent_container_spawned_total',
  help: 'Total agent containers spawned',
  labelNames: ['jid_kind', 'isMain'] as const,
  registers: [metricsRegistry],
});

const containerDurationSeconds = new Histogram({
  name: 'delegate_agent_container_duration_seconds',
  help: 'Agent container run duration in seconds',
  labelNames: ['jid_kind', 'status'] as const,
  buckets: DURATION_BUCKETS,
  registers: [metricsRegistry],
});

const containersActive = new Gauge({
  name: 'delegate_agent_containers_active',
  help: 'Number of currently active agent containers',
  registers: [metricsRegistry],
});

const queueDepth = new Gauge({
  name: 'delegate_agent_queue_depth',
  help: 'Current depth of the inbound queue',
  labelNames: ['jid_kind', 'kind'] as const,
  registers: [metricsRegistry],
});

const sessionResumesTotal = new Counter({
  name: 'delegate_agent_session_resumes_total',
  help: 'Total agent session resumes',
  labelNames: ['jid_kind'] as const,
  registers: [metricsRegistry],
});

const messagesProcessedTotal = new Counter({
  name: 'delegate_agent_messages_processed_total',
  help: 'Total messages processed by channel',
  labelNames: ['channel'] as const,
  registers: [metricsRegistry],
});

const channelMessagesDeliveredTotal = new Counter({
  name: 'delegate_agent_channel_messages_delivered_total',
  help: 'Total messages delivered to outbound channels',
  labelNames: ['channel'] as const,
  registers: [metricsRegistry],
});

const chatFastpathTotal = new Counter({
  name: 'delegate_agent_chat_fastpath_total',
  help: 'Chat fast-path invocations by outcome',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

const idleTimeoutTotal = new Counter({
  name: 'delegate_agent_idle_timeout_total',
  help: 'Total idle timeouts per JID kind',
  labelNames: ['jid_kind'] as const,
  registers: [metricsRegistry],
});

const credentialsResolvedTotal = new Counter({
  name: 'delegate_agent_credentials_resolved_total',
  help: 'Credential resolution outcomes by tier',
  labelNames: ['tier'] as const,
  registers: [metricsRegistry],
});

const credentialsAttemptTotal = new Counter({
  name: 'delegate_agent_credentials_attempt_total',
  help: 'Credential resolution attempts by tier and outcome',
  labelNames: ['tier', 'outcome'] as const,
  registers: [metricsRegistry],
});

const jwtMintTotal = new Counter({
  name: 'delegate_agent_jwt_mint_total',
  help: 'JWT mint attempts by outcome',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

const channelPollErrorsTotal = new Counter({
  name: 'delegate_agent_channel_poll_errors_total',
  help: 'Channel poll errors by channel and error kind',
  labelNames: ['channel', 'kind'] as const,
  registers: [metricsRegistry],
});

const ipcMessagesProcessedTotal = new Counter({
  name: 'delegate_agent_ipc_messages_processed_total',
  help: 'IPC messages processed by type',
  labelNames: ['type'] as const,
  registers: [metricsRegistry],
});

// ─── Public recording functions ──────────────────────────────────────────────

/** Increments spawn counter AND active gauge. */
export function recordContainerSpawn(jidKind_: JidKind, isMain: boolean): void {
  safeMetric(() => {
    containerSpawnedTotal.inc({ jid_kind: jidKind_, isMain: String(isMain) });
    containersActive.inc();
  });
}

/** Decrements active gauge AND observes duration histogram. */
export function recordContainerExit(
  jidKind_: JidKind,
  status: 'success' | 'error' | 'timeout',
  durationSeconds: number,
): void {
  safeMetric(() => {
    containersActive.dec();
    containerDurationSeconds.observe(
      { jid_kind: jidKind_, status },
      durationSeconds,
    );
  });
}

export function setQueueDepth(
  jidKind_: JidKind,
  kind: 'messages' | 'tasks',
  depth: number,
): void {
  safeMetric(() => {
    queueDepth.set({ jid_kind: jidKind_, kind }, depth);
  });
}

export function recordMessageProcessed(channel: string): void {
  safeMetric(() => {
    messagesProcessedTotal.inc({ channel });
  });
}

export function recordChannelMessageDelivered(channel: string): void {
  safeMetric(() => {
    channelMessagesDeliveredTotal.inc({ channel });
  });
}

export function recordFastpath(outcome: string): void {
  safeMetric(() => {
    chatFastpathTotal.inc({ outcome });
  });
}

export function recordIdleTimeout(jidKind_: JidKind): void {
  safeMetric(() => {
    idleTimeoutTotal.inc({ jid_kind: jidKind_ });
  });
}

export function recordCredentialResolution(
  tier: 'workspace' | 'onecli' | 'static' | 'none',
): void {
  safeMetric(() => {
    credentialsResolvedTotal.inc({ tier });
  });
}

export function recordCredentialAttempt(
  tier: 'workspace' | 'onecli' | 'static',
  outcome: string,
): void {
  safeMetric(() => {
    credentialsAttemptTotal.inc({ tier, outcome });
  });
}

export function recordJwtMint(outcome: 'success' | 'failure'): void {
  safeMetric(() => {
    jwtMintTotal.inc({ outcome });
  });
}

export function recordChannelPollError(
  channel: string,
  kind: 'http_4xx' | 'http_5xx' | 'network' | 'timeout' | 'parse',
): void {
  safeMetric(() => {
    channelPollErrorsTotal.inc({ channel, kind });
  });
}

export function recordIpcMessage(type: string): void {
  safeMetric(() => {
    ipcMessagesProcessedTotal.inc({ type });
  });
}

export function recordSessionResume(jidKind_: JidKind): void {
  safeMetric(() => {
    sessionResumesTotal.inc({ jid_kind: jidKind_ });
  });
}

// ─── Seed counters at startup so dashboards show 0 instead of "No data" ──────
// prom-client only emits a label combo once .inc() has been called for it.
// On a freshly-started process with no traffic yet, every Counter is invisible
// in /metrics — Grafana panels using rate(...) over those counters render
// "No data" instead of a confidence-inspiring 0. We seed the enumerable label
// combinations once at module load so each `recordX` path is visible
// immediately, even before any traffic.
//
// Only ENUM-LIKE labels (with bounded, known value sets) are seeded — labels
// like `tier` (open-ended for credentials) are intentionally left to populate
// organically.

function seedCounters(): void {
  safeMetric(() => {
    const KINDS: JidKind[] = [
      'main',
      'delegate_task',
      'delegate_conv',
      'delegate_agent',
      'whatsapp',
      'telegram',
      'slack',
      'discord',
      'gmail',
      'unknown',
    ];
    const CHANNELS = [
      'delegate',
      'whatsapp',
      'telegram',
      'slack',
      'discord',
      'gmail',
    ];
    const POLL_KINDS = ['http_4xx', 'http_5xx', 'network', 'timeout'];
    const FASTPATH_OUTCOMES = ['hit', 'miss', 'skip'];
    const JWT_OUTCOMES = ['success', 'failure'];
    const IPC_TYPES = ['message', 'task'];

    for (const k of KINDS) {
      containerSpawnedTotal.inc({ jid_kind: k, isMain: 'false' }, 0);
      idleTimeoutTotal.inc({ jid_kind: k }, 0);
      sessionResumesTotal.inc({ jid_kind: k }, 0);
    }
    for (const ch of CHANNELS) {
      messagesProcessedTotal.inc({ channel: ch }, 0);
      channelMessagesDeliveredTotal.inc({ channel: ch }, 0);
      for (const pk of POLL_KINDS) {
        channelPollErrorsTotal.inc({ channel: ch, kind: pk }, 0);
      }
    }
    for (const o of FASTPATH_OUTCOMES) chatFastpathTotal.inc({ outcome: o }, 0);
    for (const o of JWT_OUTCOMES) jwtMintTotal.inc({ outcome: o }, 0);
    for (const t of IPC_TYPES) ipcMessagesProcessedTotal.inc({ type: t }, 0);
  });
}

seedCounters();

// ─── HTTP handler ─────────────────────────────────────────────────────────────

export async function metricsHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (process.env.DELEGATE_AGENT_METRICS_DISABLED === '1') {
    res.statusCode = 404;
    res.end('metrics disabled');
    return;
  }
  res.setHeader('Content-Type', metricsRegistry.contentType);
  res.statusCode = 200;
  res.end(await metricsRegistry.metrics());
}
