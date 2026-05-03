import http from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './db.js';
import { startGroupAPI } from './group-api.js';

const TEST_TOKEN = 'agents-test-token-99999';
const TEST_PORT = '38424';

let serverStarted = false;

beforeAll(() => {
  process.env.DELEGATE_AGENT_TOKEN = TEST_TOKEN;
  process.env.GROUP_API_PORT = TEST_PORT;
  _initTestDatabase();
  if (!serverStarted) {
    startGroupAPI();
    serverStarted = true;
  }
});

afterAll(() => {
  // HTTP server stays open for the process lifetime; vitest will kill it.
});

// ─── helpers ─────────────────────────────────────────────────────────────────

interface FetchResult {
  status: number;
  body: string;
}

function apiRequest(
  method: string,
  pathname: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const payload =
      opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
    if (payload) headers['Content-Length'] = String(Buffer.byteLength(payload));

    const req = http.request(
      {
        host: '127.0.0.1',
        port: parseInt(TEST_PORT, 10),
        path: pathname,
        method,
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, body });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForListen(maxMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      await apiRequest('GET', '/api/health', { token: TEST_TOKEN });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error('group-api server did not start in time');
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('/api/agents registry routes', () => {
  beforeAll(async () => {
    await waitForListen();
  });

  it('POST /api/agents without Bearer returns 401', async () => {
    const r = await apiRequest('POST', '/api/agents', {
      body: { id: 'agent-1', name: 'Test Agent' },
    });
    expect(r.status).toBe(401);
  });

  it('POST /api/agents with valid body + Bearer returns 200', async () => {
    const r = await apiRequest('POST', '/api/agents', {
      token: TEST_TOKEN,
      body: {
        id: 'agent-abc',
        name: 'Test Agent',
        role: 'engineer',
        systemPrompt: 'You are a helpful agent.',
        personality: 'calm',
        color: '#ff0000',
        model: 'claude-sonnet-4-5',
      },
    });
    expect(r.status).toBe(200);
    const json = JSON.parse(r.body);
    expect(json.ok).toBe(true);
    expect(json.id).toBe('agent-abc');
  });

  it('POST /api/agents with empty id returns 400', async () => {
    const r = await apiRequest('POST', '/api/agents', {
      token: TEST_TOKEN,
      body: { id: '', name: 'Bad Agent' },
    });
    expect(r.status).toBe(400);
  });

  it('POST /api/agents with missing name returns 400', async () => {
    const r = await apiRequest('POST', '/api/agents', {
      token: TEST_TOKEN,
      body: { id: 'agent-xyz' },
    });
    expect(r.status).toBe(400);
  });

  it('GET /api/agents/:id returns the agent after creation', async () => {
    const r = await apiRequest('GET', '/api/agents/agent-abc', {
      token: TEST_TOKEN,
    });
    expect(r.status).toBe(200);
    const json = JSON.parse(r.body);
    expect(json.id).toBe('agent-abc');
    expect(json.name).toBe('Test Agent');
    expect(json.role).toBe('engineer');
    expect(json.systemPrompt).toBe('You are a helpful agent.');
    expect(json.color).toBe('#ff0000');
  });

  it('GET /api/agents/:id returns 404 for unknown agent', async () => {
    const r = await apiRequest('GET', '/api/agents/does-not-exist', {
      token: TEST_TOKEN,
    });
    expect(r.status).toBe(404);
  });

  it('GET /api/agents (list) contains the created agent', async () => {
    const r = await apiRequest('GET', '/api/agents', { token: TEST_TOKEN });
    expect(r.status).toBe(200);
    const json = JSON.parse(r.body);
    expect(Array.isArray(json.agents)).toBe(true);
    const found = json.agents.find((a: { id: string }) => a.id === 'agent-abc');
    expect(found).toBeDefined();
    expect(found.name).toBe('Test Agent');
  });

  it('POST /api/agents upserts (second call updates)', async () => {
    await apiRequest('POST', '/api/agents', {
      token: TEST_TOKEN,
      body: { id: 'agent-abc', name: 'Updated Agent', role: 'manager' },
    });
    const r = await apiRequest('GET', '/api/agents/agent-abc', {
      token: TEST_TOKEN,
    });
    const json = JSON.parse(r.body);
    expect(json.name).toBe('Updated Agent');
    expect(json.role).toBe('manager');
  });

  it('DELETE /api/agents/:id returns 200', async () => {
    const r = await apiRequest('DELETE', '/api/agents/agent-abc', {
      token: TEST_TOKEN,
    });
    expect(r.status).toBe(200);
    const json = JSON.parse(r.body);
    expect(json.ok).toBe(true);
  });

  it('GET /api/agents/:id returns 404 after deletion', async () => {
    const r = await apiRequest('GET', '/api/agents/agent-abc', {
      token: TEST_TOKEN,
    });
    expect(r.status).toBe(404);
  });

  it('DELETE /api/agents/:id returns 200 even if agent not present', async () => {
    const r = await apiRequest('DELETE', '/api/agents/never-existed', {
      token: TEST_TOKEN,
    });
    expect(r.status).toBe(200);
  });
});
