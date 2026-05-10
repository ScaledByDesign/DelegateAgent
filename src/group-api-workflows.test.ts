import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import http from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './db.js';
import { startGroupAPI } from './group-api.js';
import { _resetWorkflowCache } from './workflows/loader.js';

const TEST_TOKEN = 'workflow-test-token-77777';
const TEST_PORT = '38425';

let serverStarted = false;
let tmpRoot: string;

// ─── helpers ────────────────────────────────────────────────────────────────

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

function writeFile(p: string, contents: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents, 'utf-8');
}

function seedFixtureWorkflow(rootDir: string) {
  const wfDir = path.join(rootDir, 'demo');
  writeFile(
    path.join(wfDir, 'workflow.yaml'),
    [
      'name: "Demo"',
      'description: "demo workflow"',
      'has_result: true',
      'result_criteria: "all done"',
      'on_result_found: "stop_all"',
      'launch_template: "Begin."',
      'phase_order:',
      '  - "01_a"',
      '  - "02_b"',
      '',
    ].join('\n'),
  );
  for (const id of ['01_a', '02_b']) {
    writeFile(
      path.join(wfDir, 'phases', `${id}.yaml`),
      [
        `id: "${id}"`,
        `name: "Phase ${id}"`,
        'description: "x"',
        'done_definitions:',
        '  - "Do thing 1"',
        '  - "Do thing 2"',
        'working_directory: "."',
        'additional_notes: "n"',
        'outputs: []',
        'next_steps: []',
        '',
      ].join('\n'),
    );
  }
}

// ─── setup ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-api-test-'));
  seedFixtureWorkflow(tmpRoot);
  process.env.DELEGATE_AGENT_TOKEN = TEST_TOKEN;
  process.env.GROUP_API_PORT = TEST_PORT;
  process.env.WORKFLOWS_DIR = tmpRoot;
  _initTestDatabase();
  if (!serverStarted) {
    startGroupAPI();
    serverStarted = true;
  }
  _resetWorkflowCache();
  await waitForListen();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ─── tests ──────────────────────────────────────────────────────────────────

describe('/workflows endpoints', () => {
  it('GET /workflows without Bearer returns 401', async () => {
    const r = await apiRequest('GET', '/workflows');
    expect(r.status).toBe(401);
  });

  it('GET /workflows lists registered workflows', async () => {
    const r = await apiRequest('GET', '/workflows', { token: TEST_TOKEN });
    expect(r.status).toBe(200);
    const json = JSON.parse(r.body);
    expect(Array.isArray(json.workflows)).toBe(true);
    const found = json.workflows.find(
      (w: { name: string }) => w.name === 'demo',
    );
    expect(found).toBeDefined();
    expect(found.phaseCount).toBe(2);
    expect(found.phaseOrder).toEqual(['01_a', '02_b']);
  });

  it('GET /workflows/:name returns the unified shape', async () => {
    const r = await apiRequest('GET', '/workflows/demo', {
      token: TEST_TOKEN,
    });
    expect(r.status).toBe(200);
    const json = JSON.parse(r.body);
    expect(json.config).toBeDefined();
    expect(json.config.name).toBe('Demo');
    expect(Array.isArray(json.phases)).toBe(true);
    expect(json.phases).toHaveLength(2);
    expect(json.phases[0].id).toBe('01_a');
    expect(json.phases[0].done_definitions).toEqual([
      'Do thing 1',
      'Do thing 2',
    ]);
  });

  it('GET /workflows/:name returns 404 for unknown workflow', async () => {
    const r = await apiRequest('GET', '/workflows/nonexistent', {
      token: TEST_TOKEN,
    });
    expect(r.status).toBe(404);
  });

  it('POST /workflows/reload without Bearer returns 401', async () => {
    const r = await apiRequest('POST', '/workflows/reload');
    expect(r.status).toBe(401);
  });

  it('POST /workflows/reload re-runs the loader', async () => {
    // Add a second workflow on disk after first load and confirm reload picks it up.
    const wfDir = path.join(tmpRoot, 'second');
    writeFile(
      path.join(wfDir, 'workflow.yaml'),
      [
        'name: "Second"',
        'description: "second workflow"',
        'has_result: true',
        'result_criteria: "all done"',
        'on_result_found: "stop_all"',
        'launch_template: "go"',
        'phase_order:',
        '  - "01_only"',
        '',
      ].join('\n'),
    );
    writeFile(
      path.join(wfDir, 'phases', '01_only.yaml'),
      [
        'id: "01_only"',
        'name: "Only"',
        'description: "x"',
        'done_definitions:',
        '  - "do it"',
        'working_directory: "."',
        'additional_notes: "n"',
        'outputs: []',
        'next_steps: []',
        '',
      ].join('\n'),
    );

    const r = await apiRequest('POST', '/workflows/reload', {
      token: TEST_TOKEN,
    });
    expect(r.status).toBe(200);
    const json = JSON.parse(r.body);
    expect(json.ok).toBe(true);
    expect(json.count).toBe(2);
    expect(json.names).toEqual(['demo', 'second']);

    // GET should now reflect the new workflow.
    const list = await apiRequest('GET', '/workflows', { token: TEST_TOKEN });
    const parsed = JSON.parse(list.body);
    const names = parsed.workflows.map((w: { name: string }) => w.name).sort();
    expect(names).toEqual(['demo', 'second']);
  });
});
