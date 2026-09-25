import http from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  setRegisteredGroup,
  getAllRegisteredGroups,
  deleteRegisteredGroup,
} from './db.js';
import { startGroupAPI } from './group-api.js';
import type { RegisteredGroup } from './types.js';

// DELETE /api/groups/:jid — terminal-task deregister (2026-06-20).
// Verifies: removes the SQLite row + fires the in-memory deregister callback,
// is idempotent, and refuses always-on control JIDs.

const TEST_TOKEN = 'delete-test-token-12345';
const TEST_PORT = '38461';

// Captures jids the in-memory callback was invoked with.
const deregisteredInMemory: string[] = [];

let serverStarted = false;

beforeAll(async () => {
  process.env.DELEGATE_AGENT_TOKEN = TEST_TOKEN;
  process.env.GROUP_API_PORT = TEST_PORT;
  _initTestDatabase();
  if (!serverStarted) {
    startGroupAPI(undefined, (jid: string) => {
      deregisteredInMemory.push(jid);
    });
    serverStarted = true;
  }
  await waitForListen();
});

afterAll(() => {
  // Server stays open for process lifetime; vitest kills it.
});

interface FetchResult {
  status: number;
  body: string;
}

function request(
  method: string,
  pathname: string,
  opts: { token?: string; json?: unknown } = {},
): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
    let payload: string | undefined;
    if (opts.json !== undefined) {
      payload = JSON.stringify(opts.json);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
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
        res.on('end', () => resolve({ status: res.statusCode || 0, body }));
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
      await request('GET', '/admin/static/htmx.min.js');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error('group-api server did not start in time');
}

function seedGroup(jid: string): void {
  const group: RegisteredGroup = {
    name: `Test ${jid}`,
    folder: jid.replace(/[^a-zA-Z0-9-]/g, '-'),
    trigger: 'always',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
  };
  setRegisteredGroup(jid, group);
}

describe('DELETE /api/groups/:jid', () => {
  it('removes a task group from SQLite and fires the in-memory callback', async () => {
    const jid = 'delegate:task:abc123';
    seedGroup(jid);
    deregisteredInMemory.length = 0;

    expect(getAllRegisteredGroups()[jid]).toBeTruthy();

    const r = await request(
      'DELETE',
      `/api/groups/${encodeURIComponent(jid)}`,
      {
        token: TEST_TOKEN,
      },
    );
    expect(r.status).toBe(200);
    const json = JSON.parse(r.body);
    expect(json.ok).toBe(true);
    expect(json.existed).toBe(true);

    expect(getAllRegisteredGroups()[jid]).toBeUndefined();
    expect(deregisteredInMemory).toContain(jid);
  });

  it('is idempotent — unknown jid returns 200 existed:false', async () => {
    const jid = 'delegate:task:does-not-exist';
    deregisteredInMemory.length = 0;

    const r = await request(
      'DELETE',
      `/api/groups/${encodeURIComponent(jid)}`,
      {
        token: TEST_TOKEN,
      },
    );
    expect(r.status).toBe(200);
    const json = JSON.parse(r.body);
    expect(json.ok).toBe(true);
    expect(json.existed).toBe(false);
    // No row existed → in-memory callback NOT fired.
    expect(deregisteredInMemory).not.toContain(jid);
  });

  it('refuses to delete the always-on main control JID (409)', async () => {
    const jid = 'delegate:main';
    seedGroup(jid);

    const r = await request(
      'DELETE',
      `/api/groups/${encodeURIComponent(jid)}`,
      {
        token: TEST_TOKEN,
      },
    );
    expect(r.status).toBe(409);
    const json = JSON.parse(r.body);
    expect(json.reason).toBe('always_on');
    // Still present — never removed.
    expect(getAllRegisteredGroups()[jid]).toBeTruthy();

    // cleanup
    deleteRegisteredGroup(jid);
  });

  it('refuses to delete an always-on agent control JID (409)', async () => {
    const jid = 'delegate:agent:user-xyz';
    seedGroup(jid);

    const r = await request(
      'DELETE',
      `/api/groups/${encodeURIComponent(jid)}`,
      {
        token: TEST_TOKEN,
      },
    );
    expect(r.status).toBe(409);
    expect(getAllRegisteredGroups()[jid]).toBeTruthy();

    deleteRegisteredGroup(jid);
  });

  it('rejects without a valid Bearer token (401)', async () => {
    const jid = 'delegate:task:auth-check';
    seedGroup(jid);

    const r = await request('DELETE', `/api/groups/${encodeURIComponent(jid)}`);
    expect(r.status).toBe(401);
    // Untouched.
    expect(getAllRegisteredGroups()[jid]).toBeTruthy();

    deleteRegisteredGroup(jid);
  });
});
