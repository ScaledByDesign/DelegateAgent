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
  // Phase 5: point artifact root inside the temp dir so bash/script nodes
  // can `cd $ARTIFACTS_DIR` without needing the production /var/lib path.
  process.env.WORKFLOW_ARTIFACTS_DIR = path.join(tmpRoot, '_artifacts');
  _initTestDatabase();
  if (!serverStarted) {
    startGroupAPI();
    serverStarted = true;
  }
  _resetWorkflowCache();
  // Reset the dag-loader cache too so subsequent seedDagWorkflow calls are
  // picked up.
  const { _resetDagWorkflowCache } = await import('./workflows/dag-loader.js');
  _resetDagWorkflowCache();
  await waitForListen();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ─── tests ──────────────────────────────────────────────────────────────────

describe('/workflows endpoints', () => {
  it('GET /workflows without Bearer returns 401', async () => {
    const r = await apiRequest('GET', '/api/workflows');
    expect(r.status).toBe(401);
  });

  it('GET /workflows lists registered workflows', async () => {
    const r = await apiRequest('GET', '/api/workflows', { token: TEST_TOKEN });
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
    const r = await apiRequest('GET', '/api/workflows/demo', {
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
    const r = await apiRequest('GET', '/api/workflows/nonexistent', {
      token: TEST_TOKEN,
    });
    expect(r.status).toBe(404);
  });

  it('POST /workflows/reload without Bearer returns 401', async () => {
    const r = await apiRequest('POST', '/api/workflows/reload');
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

    const r = await apiRequest('POST', '/api/workflows/reload', {
      token: TEST_TOKEN,
    });
    expect(r.status).toBe(200);
    const json = JSON.parse(r.body);
    expect(json.ok).toBe(true);
    expect(json.count).toBe(2);
    expect(json.names).toEqual(['demo', 'second']);

    // GET should now reflect the new workflow.
    const list = await apiRequest('GET', '/api/workflows', {
      token: TEST_TOKEN,
    });
    const parsed = JSON.parse(list.body);
    const names = parsed.workflows.map((w: { name: string }) => w.name).sort();
    expect(names).toEqual(['demo', 'second']);
  });
});

// ─── Phase 5 — DAG-run lifecycle endpoints ─────────────────────────────────

function seedDagWorkflow(rootDir: string, name: string, nodes: unknown[]) {
  const wfDir = path.join(rootDir, name);
  const yaml = [
    `name: ${name}`,
    `description: ${name} dag workflow`,
    'nodes:',
    ...nodes.map((n) => `  - ${JSON.stringify(n)}`),
    '',
  ].join('\n');
  writeFile(path.join(wfDir, 'workflow.yaml'), yaml);
}

// Helper that waits for the run to settle to a non-running, non-pending state.
async function waitForRunStatus(
  runId: string,
  predicate: (s: string) => boolean,
  maxMs = 4000,
): Promise<string> {
  const start = Date.now();
  let last = 'unknown';
  while (Date.now() - start < maxMs) {
    const r = await apiRequest('GET', `/api/workflows/runs/${runId}`, {
      token: TEST_TOKEN,
    });
    if (r.status === 200) {
      const j = JSON.parse(r.body);
      last = j.run.status;
      if (predicate(last)) return last;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`run ${runId} never reached predicate; last=${last}`);
}

describe('AC A12 — bearer auth on DAG-run endpoints', () => {
  beforeAll(async () => {
    seedDagWorkflow(tmpRoot, 'echo-it', [{ id: 'a', bash: "printf 'hello'" }]);
    const { _resetDagWorkflowCache } =
      await import('./workflows/dag-loader.js');
    _resetDagWorkflowCache();
  });

  it('POST /api/workflows/:name/runs without Bearer returns 401', async () => {
    const r = await apiRequest('POST', '/api/workflows/echo-it/runs', {
      body: { userMessage: 'hi' },
    });
    expect(r.status).toBe(401);
  });

  it('GET /api/workflows/runs/:id without Bearer returns 401', async () => {
    const r = await apiRequest('GET', '/api/workflows/runs/wfr-fake');
    expect(r.status).toBe(401);
  });

  it('POST /api/workflows/runs/:id/resume without Bearer returns 401', async () => {
    const r = await apiRequest('POST', '/api/workflows/runs/wfr-fake/resume', {
      body: { decision: 'approve' },
    });
    expect(r.status).toBe(401);
  });

  it('POST /api/workflows/runs/:id/cancel without Bearer returns 401', async () => {
    const r = await apiRequest('POST', '/api/workflows/runs/wfr-fake/cancel');
    expect(r.status).toBe(401);
  });

  it('POST /api/workflows/runs/:id/abandon without Bearer returns 401', async () => {
    const r = await apiRequest('POST', '/api/workflows/runs/wfr-fake/abandon');
    expect(r.status).toBe(401);
  });
});

describe('Phase 5 — DAG-run start + lifecycle', () => {
  beforeAll(async () => {
    seedDagWorkflow(tmpRoot, 'echo-it', [{ id: 'a', bash: "printf 'hello'" }]);
    seedDagWorkflow(tmpRoot, 'approve-it', [
      { id: 'a', bash: "printf 'data'" },
      {
        id: 'approve',
        depends_on: ['a'],
        approval: { message: 'Approve the plan?' },
      },
      { id: 'ship', depends_on: ['approve'], bash: 'echo shipped' },
    ]);
    seedDagWorkflow(tmpRoot, 'ghost-it', [
      { id: 'sleep', bash: 'sleep 5', timeout: 30000 },
    ]);
    const { _resetDagWorkflowCache } =
      await import('./workflows/dag-loader.js');
    _resetDagWorkflowCache();
  });

  it('POST /:name/runs starts a run and returns 202 + workflowRunId', async () => {
    const r = await apiRequest('POST', '/api/workflows/echo-it/runs', {
      token: TEST_TOKEN,
      body: { userMessage: 'start it' },
    });
    expect(r.status).toBe(202);
    const j = JSON.parse(r.body);
    expect(j.workflowRunId).toMatch(/^wfr-/);
    expect(['pending', 'running']).toContain(j.status);
    expect(typeof j.queued).toBe('boolean');
  });

  it('POST /:name/runs with no userMessage returns 400', async () => {
    const r = await apiRequest('POST', '/api/workflows/echo-it/runs', {
      token: TEST_TOKEN,
      body: {},
    });
    expect(r.status).toBe(400);
  });

  it('POST /:name/runs with unknown workflow returns 404', async () => {
    const r = await apiRequest('POST', '/api/workflows/no-such-flow/runs', {
      token: TEST_TOKEN,
      body: { userMessage: 'x' },
    });
    expect(r.status).toBe(404);
  });

  it('GET /runs/:id returns the snapshot once the run completes', async () => {
    const start = await apiRequest('POST', '/api/workflows/echo-it/runs', {
      token: TEST_TOKEN,
      body: { userMessage: 'snapshot test' },
    });
    const { workflowRunId } = JSON.parse(start.body);

    await waitForRunStatus(workflowRunId, (s) => s === 'completed');

    const get = await apiRequest(
      'GET',
      `/api/workflows/runs/${workflowRunId}`,
      { token: TEST_TOKEN },
    );
    expect(get.status).toBe(200);
    const snap = JSON.parse(get.body);
    expect(snap.run.id).toBe(workflowRunId);
    expect(snap.run.status).toBe('completed');
    expect(Array.isArray(snap.nodes)).toBe(true);
    expect(Array.isArray(snap.events)).toBe(true);
    expect(snap.nodes[0]).toMatchObject({ nodeId: 'a', state: 'completed' });
    // GET response strips internal metadata.loop_state.
    expect(snap.run.metadata.loop_state).toBeUndefined();
  });

  it('GET /runs/:id returns 404 for unknown run', async () => {
    const r = await apiRequest('GET', '/api/workflows/runs/wfr-missing', {
      token: TEST_TOKEN,
    });
    expect(r.status).toBe(404);
  });

  it('approval workflow: start → pause → resume(approve) → complete', async () => {
    const start = await apiRequest('POST', '/api/workflows/approve-it/runs', {
      token: TEST_TOKEN,
      body: { userMessage: 'approve me' },
    });
    const { workflowRunId } = JSON.parse(start.body);

    // Wait for pause.
    await waitForRunStatus(workflowRunId, (s) => s === 'paused');
    const paused = await apiRequest(
      'GET',
      `/api/workflows/runs/${workflowRunId}`,
      { token: TEST_TOKEN },
    );
    const pausedSnap = JSON.parse(paused.body);
    expect(pausedSnap.run.status).toBe('paused');
    expect(pausedSnap.run.metadata.approval.nodeId).toBe('approve');
    expect(pausedSnap.run.metadata.approval.message).toBe('Approve the plan?');
    // workflow.run_paused event carries the gate message (Phase 5 architect note).
    const pausedEvent = pausedSnap.events.find(
      (e: { eventType: string }) => e.eventType === 'workflow.run_paused',
    );
    expect(pausedEvent).toBeDefined();
    expect(pausedEvent.data.message).toBe('Approve the plan?');
    expect(pausedEvent.data.approval_id).toBe(`wf:${workflowRunId}:approve`);

    // Resume(approve).
    const resume = await apiRequest(
      'POST',
      `/api/workflows/runs/${workflowRunId}/resume`,
      { token: TEST_TOKEN, body: { decision: 'approve' } },
    );
    expect(resume.status).toBe(202);

    await waitForRunStatus(workflowRunId, (s) => s === 'completed');
    const done = await apiRequest(
      'GET',
      `/api/workflows/runs/${workflowRunId}`,
      { token: TEST_TOKEN },
    );
    const doneSnap = JSON.parse(done.body);
    expect(doneSnap.run.status).toBe('completed');
    const ship = doneSnap.nodes.find(
      (n: { nodeId: string }) => n.nodeId === 'ship',
    );
    expect(ship.state).toBe('completed');
  });

  it('approval workflow: resume(reject) cancels the run', async () => {
    const start = await apiRequest('POST', '/api/workflows/approve-it/runs', {
      token: TEST_TOKEN,
      body: { userMessage: 'reject me' },
    });
    const { workflowRunId } = JSON.parse(start.body);
    await waitForRunStatus(workflowRunId, (s) => s === 'paused');

    const resume = await apiRequest(
      'POST',
      `/api/workflows/runs/${workflowRunId}/resume`,
      {
        token: TEST_TOKEN,
        body: { decision: 'reject', reason: 'not this time' },
      },
    );
    expect(resume.status).toBe(202);

    await waitForRunStatus(workflowRunId, (s) => s === 'cancelled');
  });

  it('resume with empty reason returns 400', async () => {
    const start = await apiRequest('POST', '/api/workflows/approve-it/runs', {
      token: TEST_TOKEN,
      body: { userMessage: 'bad reject' },
    });
    const { workflowRunId } = JSON.parse(start.body);
    await waitForRunStatus(workflowRunId, (s) => s === 'paused');

    const resume = await apiRequest(
      'POST',
      `/api/workflows/runs/${workflowRunId}/resume`,
      { token: TEST_TOKEN, body: { decision: 'reject' } },
    );
    expect(resume.status).toBe(400);
  });

  it('resume with invalid decision returns 400', async () => {
    const start = await apiRequest('POST', '/api/workflows/approve-it/runs', {
      token: TEST_TOKEN,
      body: { userMessage: 'bad decision' },
    });
    const { workflowRunId } = JSON.parse(start.body);
    await waitForRunStatus(workflowRunId, (s) => s === 'paused');

    const resume = await apiRequest(
      'POST',
      `/api/workflows/runs/${workflowRunId}/resume`,
      { token: TEST_TOKEN, body: { decision: 'maybe' } },
    );
    expect(resume.status).toBe(400);
  });

  it('cancel a running workflow flips it to cancelling/cancelled', async () => {
    const start = await apiRequest('POST', '/api/workflows/ghost-it/runs', {
      token: TEST_TOKEN,
      body: { userMessage: 'cancel me' },
    });
    const { workflowRunId } = JSON.parse(start.body);
    // Hit cancel almost immediately while the bash sleep is in flight.
    const cancel = await apiRequest(
      'POST',
      `/api/workflows/runs/${workflowRunId}/cancel`,
      { token: TEST_TOKEN },
    );
    expect(cancel.status).toBe(202);
    const j = JSON.parse(cancel.body);
    expect(['cancelling', 'cancelled', 'failed']).toContain(j.status);
  });

  it('abandon a paused run terminal-flips to failed', async () => {
    const start = await apiRequest('POST', '/api/workflows/approve-it/runs', {
      token: TEST_TOKEN,
      body: { userMessage: 'abandon me' },
    });
    const { workflowRunId } = JSON.parse(start.body);
    await waitForRunStatus(workflowRunId, (s) => s === 'paused');

    const abandon = await apiRequest(
      'POST',
      `/api/workflows/runs/${workflowRunId}/abandon`,
      { token: TEST_TOKEN },
    );
    expect(abandon.status).toBe(202);
    const j = JSON.parse(abandon.body);
    expect(j.status).toBe('failed');

    // Subsequent GET confirms the terminal state.
    const get = await apiRequest(
      'GET',
      `/api/workflows/runs/${workflowRunId}`,
      { token: TEST_TOKEN },
    );
    const snap = JSON.parse(get.body);
    expect(snap.run.status).toBe('failed');
    expect(snap.run.metadata.abandon_reason).toBe('abandoned_via_api');
  });

  it('AC A9 — paused run remains paused across simulated restart', async () => {
    // Phase 1.5's sweepOrphanedRunningRuns(db) marks running rows as failed
    // on init, but leaves paused rows alone. Simulate by:
    //   1) starting a run, waiting until paused
    //   2) calling sweepOrphanedRunningRuns(db) directly (the same code the
    //      init path runs at startup)
    //   3) GET /runs/:id — status must still be 'paused' + resumable
    const { sweepOrphanedRunningRuns } = await import('./db-workflows.js');
    const { _getDb } = await import('./db.js');

    const start = await apiRequest('POST', '/api/workflows/approve-it/runs', {
      token: TEST_TOKEN,
      body: { userMessage: 'survive restart' },
    });
    const { workflowRunId } = JSON.parse(start.body);
    await waitForRunStatus(workflowRunId, (s) => s === 'paused');

    // Simulated restart sweep.
    const sweptCount = sweepOrphanedRunningRuns(_getDb());
    // A9: paused rows MUST be left alone — sweep doesn't touch them.
    void sweptCount;

    const get = await apiRequest(
      'GET',
      `/api/workflows/runs/${workflowRunId}`,
      { token: TEST_TOKEN },
    );
    expect(get.status).toBe(200);
    const snap = JSON.parse(get.body);
    expect(snap.run.status).toBe('paused');
    expect(snap.run.metadata.approval.nodeId).toBe('approve');

    // Resume after "restart" still works.
    await apiRequest('POST', `/api/workflows/runs/${workflowRunId}/resume`, {
      token: TEST_TOKEN,
      body: { decision: 'approve' },
    });
    await waitForRunStatus(workflowRunId, (s) => s === 'completed');
  });
});
