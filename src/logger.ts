import { EventEmitter } from 'node:events';

// ─── Log ring buffer (cap 500) ───────────────────────────────────────────────
// Stores the last LOG_BUFFER_CAP formatted log lines for the /admin/partials/logs
// partial and the /admin/sse/logs SSE stream. Both JSON and pretty lines land here.
const LOG_BUFFER_CAP = 500;
const LOG_BUFFER: string[] = [];

/** Returns a shallow copy of the recent log buffer (newest last). */
export function getRecentLogs(): string[] {
  return LOG_BUFFER.slice();
}

/**
 * EventEmitter that emits `'line'` for every new log line written to the buffer.
 * SSE consumers subscribe via `logSubscriber.on('line', handler)` and MUST call
 * `.off('line', handler)` on disconnect to prevent memory leaks.
 */
export const logSubscriber = new EventEmitter();
logSubscriber.setMaxListeners(100); // allow many concurrent SSE clients

function pushToBuffer(line: string): void {
  LOG_BUFFER.push(line);
  if (LOG_BUFFER.length > LOG_BUFFER_CAP) {
    LOG_BUFFER.shift();
  }
  logSubscriber.emit('line', line);
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── JSON log schema (when LOG_FORMAT=json) ─────────────────────────────────
// Every line is a single newline-terminated JSON object with these fields:
//   ts      string  ISO 8601 timestamp (e.g. "2026-05-02T14:23:01.456Z")
//   level   string  "debug" | "info" | "warn" | "error" | "fatal"
//   msg     string  Human-readable message
//   context object  (optional) Arbitrary key/value pairs from the first
//                   argument when called as log({ key: val }, "msg")
//
// Known context keys (not exhaustive):
//   groupFolder  string  Group folder name
//   taskId       string  Task ID
//   chatJid      string  WhatsApp/channel JID
//   containerName string Container name
//   err          any     Error object (message + stack serialized)
//
// Human-readable format (LOG_FORMAT=pretty or unset) is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

const COLORS: Record<Level, string> = {
  debug: '\x1b[34m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m\x1b[37m',
};
const KEY_COLOR = '\x1b[35m';
const MSG_COLOR = '\x1b[36m';
const RESET = '\x1b[39m';
const FULL_RESET = '\x1b[0m';

const threshold =
  LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

// JSON output mode: set LOG_FORMAT=json to emit newline-delimited JSON.
// Default (LOG_FORMAT=pretty or unset) uses human-readable colored output.
// Checked at call time (not module load) so tests can override via process.env.
function isJsonFormat(): boolean {
  return process.env.LOG_FORMAT === 'json';
}

function serializeErr(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      type: err.constructor.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return { raw: String(err) };
}

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return `{\n      "type": "${err.constructor.name}",\n      "message": "${err.message}",\n      "stack":\n          ${err.stack}\n    }`;
  }
  return JSON.stringify(err);
}

function formatData(data: Record<string, unknown>): string {
  let out = '';
  for (const [k, v] of Object.entries(data)) {
    if (k === 'err') {
      out += `\n    ${KEY_COLOR}err${RESET}: ${formatErr(v)}`;
    } else {
      out += `\n    ${KEY_COLOR}${k}${RESET}: ${JSON.stringify(v)}`;
    }
  }
  return out;
}

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function log(
  level: Level,
  dataOrMsg: Record<string, unknown> | string,
  msg?: string,
): void {
  if (LEVELS[level] < threshold) return;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;

  if (isJsonFormat()) {
    // JSON output mode: one compact JSON object per line, no ANSI codes.
    const data = typeof dataOrMsg === 'string' ? {} : dataOrMsg;
    const message = typeof dataOrMsg === 'string' ? dataOrMsg : (msg ?? '');
    const context: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      context[k] = k === 'err' ? serializeErr(v) : v;
    }
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg: message,
    };
    if (Object.keys(context).length > 0) {
      entry.context = context;
    }
    const line = JSON.stringify(entry) + '\n';
    stream.write(line);
    pushToBuffer(line.trimEnd());
    return;
  }

  // Human-readable (pretty) mode — original behavior unchanged.
  const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
  let line: string;
  if (typeof dataOrMsg === 'string') {
    line = `[${ts()}] ${tag} (${process.pid}): ${MSG_COLOR}${dataOrMsg}${RESET}\n`;
  } else {
    line = `[${ts()}] ${tag} (${process.pid}): ${MSG_COLOR}${msg}${RESET}${formatData(dataOrMsg)}\n`;
  }
  stream.write(line);
  pushToBuffer(line.trimEnd());
}

export const logger = {
  debug: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('debug', dataOrMsg, msg),
  info: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('info', dataOrMsg, msg),
  warn: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('warn', dataOrMsg, msg),
  error: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('error', dataOrMsg, msg),
  fatal: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('fatal', dataOrMsg, msg),
};

// Route uncaught errors through logger so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
