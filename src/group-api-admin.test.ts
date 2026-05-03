import http from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { logger } from './logger.js';

import { _initTestDatabase } from './db.js';
import { startGroupAPI } from './group-api.js';

const TEST_TOKEN = 'admin-test-token-12345';
const TEST_PORT = '38423';

let serverStarted = false;

beforeAll(() => {
  // Wire test token + port BEFORE startGroupAPI runs
  process.env.DELEGATE_AGENT_TOKEN = TEST_TOKEN;
  process.env.GROUP_API_PORT = TEST_PORT;
  _initTestDatabase();
  if (!serverStarted) {
    startGroupAPI();
    serverStarted = true;
  }
});

afterAll(() => {
  // The HTTP server stays open for the process lifetime; vitest will kill it.
});

interface FetchResult {
  status: number;
  contentType: string;
  body: string;
}

function fetchAdmin(
  pathname: string,
  opts: { token?: string } = {},
): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: parseInt(TEST_PORT, 10),
        path: pathname,
        method: 'GET',
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            contentType: String(res.headers['content-type'] || ''),
            body,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// Allow the listening callback to fire before tests run
async function waitForListen(maxMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      await fetchAdmin('/admin/static/htmx.min.js');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error('group-api server did not start in time');
}

describe('admin dashboard', () => {
  beforeAll(async () => {
    await waitForListen();
  });

  it('GET /admin returns HTML shell with valid Bearer', async () => {
    const r = await fetchAdmin('/admin', { token: TEST_TOKEN });
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/html');
    expect(r.body).toContain('DelegateAgent Console');
    expect(r.body).toContain('/admin/static/htmx.min.js');
  });

  it('GET /admin without Bearer returns 401', async () => {
    const r = await fetchAdmin('/admin');
    expect(r.status).toBe(401);
    expect(r.body).toContain('Unauthorized');
  });

  it('GET /admin/partials/groups returns HTML with valid Bearer', async () => {
    const r = await fetchAdmin('/admin/partials/groups', { token: TEST_TOKEN });
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/html');
    expect(r.body).toContain('Registered Groups');
  });

  it('GET /admin/partials/containers returns HTML with valid Bearer', async () => {
    const r = await fetchAdmin('/admin/partials/containers', {
      token: TEST_TOKEN,
    });
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/html');
    expect(r.body).toContain('Container Invocations');
  });

  it('GET /admin/partials/scheduler returns HTML with valid Bearer', async () => {
    const r = await fetchAdmin('/admin/partials/scheduler', {
      token: TEST_TOKEN,
    });
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/html');
    expect(r.body).toContain('Scheduled Tasks');
  });

  it('GET /admin/static/htmx.min.js is publicly accessible (bypass auth)', async () => {
    const r = await fetchAdmin('/admin/static/htmx.min.js');
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('application/javascript');
    expect(r.body.length).toBeGreaterThan(1000);
  });

  it('GET /admin/static/../etc/passwd is rejected', async () => {
    // The regex already constrains to flat filenames, so this should 404
    const r = await fetchAdmin('/admin/static/..%2Fetc%2Fpasswd');
    // Either 404 (route mismatch) or 401 (auth gate) is acceptable;
    // critical thing is no traversal succeeded.
    expect([401, 404]).toContain(r.status);
  });

  it('GET /admin/partials/logs returns HTML with valid Bearer', async () => {
    const r = await fetchAdmin('/admin/partials/logs', { token: TEST_TOKEN });
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/html');
    expect(r.body).toContain('logs-pane');
  });

  it('GET /admin/partials/logs without Bearer returns 401', async () => {
    const r = await fetchAdmin('/admin/partials/logs');
    expect(r.status).toBe(401);
    expect(r.body).toContain('Unauthorized');
  });

  it('GET /api/admin/logs.json returns JSON ring buffer with valid Bearer', async () => {
    // Seed a recognizable log line so the buffer is non-empty
    const marker = `logs-json-marker-${Date.now()}`;
    logger.info({ marker }, 'JSON logs endpoint test line');

    const r = await fetchAdmin('/api/admin/logs.json', { token: TEST_TOKEN });
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('application/json');
    const body = JSON.parse(r.body);
    expect(Array.isArray(body.lines)).toBe(true);
    expect(typeof body.capturedAt).toBe('string');
    expect(body.capacity).toBe(500);
    // marker should be present in at least one line
    expect(body.lines.some((l: string) => l.includes(marker))).toBe(true);
  });

  it('GET /api/admin/logs.json without Bearer returns 401', async () => {
    const r = await fetchAdmin('/api/admin/logs.json');
    expect(r.status).toBe(401);
  });

  it('GET /api/admin/scheduled-tasks.json returns JSON tasks array with valid Bearer', async () => {
    const r = await fetchAdmin('/api/admin/scheduled-tasks.json', {
      token: TEST_TOKEN,
    });
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('application/json');
    const body = JSON.parse(r.body);
    expect(Array.isArray(body.tasks)).toBe(true);
  });

  it('GET /api/admin/scheduled-tasks.json without Bearer returns 401', async () => {
    const r = await fetchAdmin('/api/admin/scheduled-tasks.json');
    expect(r.status).toBe(401);
  });

  it('GET /api/admin/container-telemetry.json returns JSON containers array with valid Bearer', async () => {
    const r = await fetchAdmin('/api/admin/container-telemetry.json', {
      token: TEST_TOKEN,
    });
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('application/json');
    const body = JSON.parse(r.body);
    expect(Array.isArray(body.containers)).toBe(true);
  });

  it('GET /api/admin/container-telemetry.json without Bearer returns 401', async () => {
    const r = await fetchAdmin('/api/admin/container-telemetry.json');
    expect(r.status).toBe(401);
  });

  it('GET /api/admin/channels.json returns JSON channel names with valid Bearer', async () => {
    const r = await fetchAdmin('/api/admin/channels.json', {
      token: TEST_TOKEN,
    });
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('application/json');
    const body = JSON.parse(r.body);
    expect(Array.isArray(body.channels)).toBe(true);
    // Every entry must be a string (channel names are string keys from the registry)
    expect(body.channels.every((c: unknown) => typeof c === 'string')).toBe(
      true,
    );
  });

  it('GET /api/admin/channels.json without Bearer returns 401', async () => {
    const r = await fetchAdmin('/api/admin/channels.json');
    expect(r.status).toBe(401);
  });

  it('GET /admin/sse/logs streams text/event-stream and contains a buffered log line', async () => {
    // Emit a log line into the buffer BEFORE connecting so the initial flush carries it
    const marker = `sse-test-marker-${Date.now()}`;
    logger.info({ marker }, 'SSE log stream test line');

    await new Promise<void>((resolve, reject) => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${TEST_TOKEN}`,
        Accept: 'text/event-stream',
      };
      const req = http.request(
        {
          host: '127.0.0.1',
          port: parseInt(TEST_PORT, 10),
          path: '/admin/sse/logs',
          method: 'GET',
          headers,
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          expect(String(res.headers['content-type'] ?? '')).toContain(
            'text/event-stream',
          );

          let received = '';
          const timeout = setTimeout(() => {
            req.destroy();
            reject(
              new Error(
                `Timed out waiting for marker "${marker}" in SSE stream. Received so far:\n${received}`,
              ),
            );
          }, 2000);

          res.on('data', (chunk: Buffer) => {
            received += chunk.toString();
            if (received.includes(marker)) {
              clearTimeout(timeout);
              req.destroy();
              resolve();
            }
          });

          res.on('end', () => {
            // Connection closed before we saw the marker
            clearTimeout(timeout);
            if (!received.includes(marker)) {
              reject(
                new Error(
                  `Stream ended without marker "${marker}". Received:\n${received}`,
                ),
              );
            }
          });
        },
      );
      req.on('error', (err) => {
        // req.destroy() fires an error — treat it as success if marker was seen
        if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return;
        reject(err);
      });
      req.end();
    });
  });
});
