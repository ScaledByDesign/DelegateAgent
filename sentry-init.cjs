// DelegateAgent Sentry initialization — preloaded via `node --require ./sentry-init.cjs`.
// Copied to /opt/delegate-agent/sentry-init.cjs on the droplet.
//
// `@sentry/node` is an OPTIONAL dependency — if it's not installed (e.g. after
// `npm ci --omit=optional` or during local dev without Sentry), this file
// no-ops gracefully instead of blocking startup.

let Sentry;
try {
  Sentry = require('@sentry/node');
} catch (err) {
  console.warn('[sentry] @sentry/node not installed — error tracking disabled');
  // No-op globals so other modules that look for __SENTRY__ don't crash
  global.__SENTRY__ = null;
  return;
}

Sentry.init({
  dsn: process.env.SENTRY_DSN || 'https://0f29fb05ca9953ee4b13beaab96be4c6@o137686.ingest.us.sentry.io/4511129079775232',
  environment: process.env.NODE_ENV || 'production',
  serverName: 'delegate-agent-' + (process.env.DELEGATE_AGENT_GROUP || process.env.NANOCLAW_GROUP || 'main'),

  tracesSampleRate: 0.2,
  includeLocalVariables: true,
  enableTracing: true,
  sendDefaultPii: true,

  initialScope: {
    tags: {
      service: 'delegate-agent',
      droplet_ip: process.env.DROPLET_IP || 'unknown',
    },
  },

  // Capture errors from Claude Agent SDK, container crashes, etc.
  beforeSend(event) {
    // Tag Claude/LLM errors for easy filtering
    const msg = event.exception?.values?.[0]?.value || '';
    if (msg.includes('anthropic') || msg.includes('claude') || msg.includes('openai')) {
      event.tags = { ...event.tags, error_domain: 'llm' };
    }
    if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('fetch failed')) {
      event.tags = { ...event.tags, error_domain: 'network' };
    }
    if (msg.includes('container') || msg.includes('docker') || msg.includes('spawn')) {
      event.tags = { ...event.tags, error_domain: 'container' };
    }
    return event;
  },
});

// ─── Bifrost Health Monitor ───
// Periodically check Bifrost AI gateway and report failures to Sentry
const BIFROST_URL = process.env.BIFROST_URL || 'http://localhost:4000';
const BIFROST_CHECK_INTERVAL = 60_000; // every 60s

let bifrostHealthy = true;
let bifrostFailCount = 0;

async function checkBifrostHealth() {
  try {
    const res = await fetch(`${BIFROST_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      if (!bifrostHealthy) {
        console.log('[sentry] Bifrost recovered after', bifrostFailCount, 'failures');
        Sentry.addBreadcrumb({ category: 'bifrost', message: 'Recovered', level: 'info' });
      }
      bifrostHealthy = true;
      bifrostFailCount = 0;
    } else {
      throw new Error(`Bifrost HTTP ${res.status}`);
    }
  } catch (err) {
    bifrostFailCount++;
    bifrostHealthy = false;
    // Report on 1st failure and every 10th
    if (bifrostFailCount === 1 || bifrostFailCount % 10 === 0) {
      Sentry.withScope((scope) => {
        scope.setTag('component', 'bifrost');
        scope.setTag('error_domain', 'infrastructure');
        scope.setExtra('consecutiveFailures', bifrostFailCount);
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
      });
      console.warn('[sentry] Bifrost health check failed:', bifrostFailCount, 'times');
    }
  }
}

setInterval(checkBifrostHealth, BIFROST_CHECK_INTERVAL);
// Initial check after 10s (let services start up)
setTimeout(checkBifrostHealth, 10_000);

// ─── Process-level error capture ───
process.on('unhandledRejection', (reason) => {
  Sentry.withScope((scope) => {
    scope.setTag('error_type', 'unhandled_rejection');
    Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
  });
});

// ─── Expose Sentry for other modules ───
global.__SENTRY__ = Sentry;

console.log('[sentry] DelegateAgent error tracking initialized (Bifrost monitor active)');
