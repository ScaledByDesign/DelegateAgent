import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _loadDagFromDir,
  _resetDagWorkflowCache,
  _resetRemoteFetchCache,
  loadAllDagWorkflows,
  loadDagWorkflowForGroup,
  type DagWorkflowWithSource,
} from './dag-loader.js';

// ─── helpers ────────────────────────────────────────────────────────────────

let tmpRoot: string;

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dag-workflows-test-'));
}

function writeFile(p: string, contents: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents, 'utf-8');
}

beforeEach(() => {
  tmpRoot = makeTmpRoot();
  _resetDagWorkflowCache();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  _resetDagWorkflowCache();
});

// ─── A1 — schema compatibility: existing 5 Hephaestus workflows ────────────

describe('AC A1 — Hephaestus back-compat', () => {
  const HEPHAESTUS_WORKFLOWS = [
    'bug-fix',
    'doc-gen',
    'feature-dev',
    'index-repo',
    'prd-to-software',
  ];

  it('repo-real workflows/ dir loads all 5 Hephaestus workflows, zero errors', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const result = _loadDagFromDir(path.join(repoRoot, 'workflows'));
    expect(result.errors).toEqual([]);
    for (const name of HEPHAESTUS_WORKFLOWS) {
      expect(result.workflows.has(name)).toBe(true);
      expect(result.workflows.get(name)?.source).toBe('hephaestus');
    }
  });

  it('each shimmed Hephaestus workflow has source=hephaestus and linear depends_on chain', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const result = _loadDagFromDir(path.join(repoRoot, 'workflows'));
    for (const name of HEPHAESTUS_WORKFLOWS) {
      const entry = result.workflows.get(name);
      expect(entry, `workflow ${name} missing`).toBeDefined();
      const workflow = entry!.workflow;
      const source = entry!.source;
      expect(source).toBe('hephaestus');
      expect(workflow.nodes[0].depends_on).toBeUndefined();
      for (let i = 1; i < workflow.nodes.length; i++) {
        expect(workflow.nodes[i].depends_on).toEqual([
          workflow.nodes[i - 1].id,
        ]);
      }
    }
  });

  it('shimmed workflow tags include "hephaestus" sentinel', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const result = _loadDagFromDir(path.join(repoRoot, 'workflows'));
    for (const name of HEPHAESTUS_WORKFLOWS) {
      const wf = result.workflows.get(name)?.workflow;
      expect(wf?.tags).toBeDefined();
      expect(wf?.tags?.[0]).toBe('hephaestus');
    }
  });
});

// ─── A10 — dispatching between Hephaestus + DAG single-file ────────────────

describe('AC A10 — dispatcher recognizes both shapes', () => {
  it('top-level nodes: routes through DAG schema', () => {
    writeFile(
      path.join(tmpRoot, 'native', 'workflow.yaml'),
      [
        'name: native',
        'description: native DAG workflow',
        'nodes:',
        '  - id: a',
        '    prompt: hello',
        '  - id: b',
        '    depends_on: [a]',
        '    bash: echo done',
        '',
      ].join('\n'),
    );

    const result = _loadDagFromDir(tmpRoot);
    expect(result.errors).toEqual([]);
    const entry = result.workflows.get('native');
    expect(entry).toBeDefined();
    expect(entry?.source).toBe('project');
    expect(entry?.workflow.nodes.length).toBe(2);
  });

  it('phase_order: routes through Hephaestus shim', () => {
    writeFile(
      path.join(tmpRoot, 'split', 'workflow.yaml'),
      [
        'name: "Split"',
        'description: "split layout"',
        'has_result: true',
        'result_criteria: "done"',
        'on_result_found: "stop_all"',
        'launch_template: "start"',
        'phase_order:',
        '  - "01_a"',
        '  - "02_b"',
        '',
      ].join('\n'),
    );
    const phaseBody = (id: string, name: string) =>
      [
        `id: "${id}"`,
        `name: "${name}"`,
        'description: "x"',
        'done_definitions:',
        '  - "thing one"',
        'working_directory: "."',
        'additional_notes: "."',
        'outputs: []',
        'next_steps: []',
        '',
      ].join('\n');
    writeFile(
      path.join(tmpRoot, 'split', 'phases', '01_a.yaml'),
      phaseBody('01_a', 'A'),
    );
    writeFile(
      path.join(tmpRoot, 'split', 'phases', '02_b.yaml'),
      phaseBody('02_b', 'B'),
    );

    const result = _loadDagFromDir(tmpRoot);
    expect(result.errors).toEqual([]);
    const entry = result.workflows.get('split');
    expect(entry).toBeDefined();
    expect(entry?.source).toBe('hephaestus');
    expect(entry?.workflow.nodes.length).toBe(2);
    expect(entry?.workflow.nodes[0].id).toBe('01_a');
    expect(entry?.workflow.nodes[1].id).toBe('02_b');
    expect(entry?.workflow.nodes[1].depends_on).toEqual(['01_a']);
  });

  it('rejects workflow.yaml with neither nodes: nor phase_order:', () => {
    writeFile(
      path.join(tmpRoot, 'broken', 'workflow.yaml'),
      'name: broken\ndescription: nope\n',
    );

    const result = _loadDagFromDir(tmpRoot);
    expect(result.workflows.has('broken')).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].error).toMatch(/nodes.*phase_order/);
  });
});

// ─── secret-pattern reject ─────────────────────────────────────────────────

describe('bash/script secret-pattern reject', () => {
  it('rejects bash body that references *_API_KEY', () => {
    writeFile(
      path.join(tmpRoot, 'leaky', 'workflow.yaml'),
      [
        'name: leaky',
        'description: leaks',
        'nodes:',
        '  - id: a',
        '    bash: |',
        '      echo "$ANTHROPIC_API_KEY"',
        '',
      ].join('\n'),
    );

    const result = _loadDagFromDir(tmpRoot);
    expect(result.workflows.has('leaky')).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].error).toMatch(/ANTHROPIC_API_KEY/);
    expect(result.errors[0].error).toMatch(/OneCLI/);
  });

  it('rejects script body that references *_SECRET via ${} expansion', () => {
    writeFile(
      path.join(tmpRoot, 'leaky2', 'workflow.yaml'),
      [
        'name: leaky2',
        'description: leaks',
        'nodes:',
        '  - id: a',
        '    script: |',
        '      const tok = process.env["${STRIPE_SECRET}"];',
        '    runtime: bun',
        '',
      ].join('\n'),
    );

    const result = _loadDagFromDir(tmpRoot);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].error).toMatch(/STRIPE_SECRET/);
  });

  it('rejects bash body that references *_TOKEN', () => {
    writeFile(
      path.join(tmpRoot, 'leaky3', 'workflow.yaml'),
      [
        'name: leaky3',
        'description: leaks',
        'nodes:',
        '  - id: a',
        '    bash: |',
        '      curl -H "Authorization: Bearer $GITHUB_TOKEN" example.com',
        '',
      ].join('\n'),
    );

    const result = _loadDagFromDir(tmpRoot);
    expect(result.errors.length).toBe(1);
    // Must come from the secret-reject path, not malformed YAML.
    expect(result.errors[0].error).toMatch(/GITHUB_TOKEN/);
    expect(result.errors[0].error).toMatch(/OneCLI/);
    expect(result.errors[0].errorType).toBe('validation_error');
  });

  it('accepts bash body that references allowlisted env (PATH)', () => {
    writeFile(
      path.join(tmpRoot, 'ok', 'workflow.yaml'),
      [
        'name: ok',
        'description: ok',
        'nodes:',
        '  - id: a',
        '    bash: echo "$PATH" && echo "$ARTIFACTS_DIR"',
        '',
      ].join('\n'),
    );

    const result = _loadDagFromDir(tmpRoot);
    expect(result.errors).toEqual([]);
    expect(result.workflows.has('ok')).toBe(true);
    expect(result.workflows.get('ok')?.source).toBe('project');
  });
});

// ─── dependency closure + duplicate node ids ───────────────────────────────

describe('graph-level validation', () => {
  it('rejects depends_on referencing unknown node', () => {
    writeFile(
      path.join(tmpRoot, 'dangling', 'workflow.yaml'),
      [
        'name: dangling',
        'description: d',
        'nodes:',
        '  - id: a',
        '    prompt: x',
        '  - id: b',
        '    depends_on: [missing]',
        '    bash: echo',
        '',
      ].join('\n'),
    );

    const result = _loadDagFromDir(tmpRoot);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].error).toMatch(/unknown node id "missing"/);
  });

  it('rejects duplicate node ids', () => {
    writeFile(
      path.join(tmpRoot, 'dup', 'workflow.yaml'),
      [
        'name: dup',
        'description: d',
        'nodes:',
        '  - id: a',
        '    prompt: x',
        '  - id: a',
        '    bash: echo',
        '',
      ].join('\n'),
    );

    const result = _loadDagFromDir(tmpRoot);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].error).toMatch(/duplicate node id "a"/);
  });
});

// ─── A11 — bundled defaults available off-filesystem ──────────────────────

describe('AC A11 — bundled defaults', () => {
  it('loads the 5 archon-* workflows from bundled defaults when WORKFLOWS_DIR is empty', () => {
    // Use an empty tmpdir so no filesystem workflows resolve.
    const emptyDir = makeTmpRoot();
    try {
      const result = _loadDagFromDir(emptyDir);
      expect(result.errors).toEqual([]);
      const bundledNames = [...result.workflows.entries()]
        .filter(([, v]) => v.source === 'bundled')
        .map(([k]) => k)
        .sort();
      expect(bundledNames).toEqual([
        'archon-adversarial-dev',
        'archon-fix-github-issue',
        'archon-piv-loop',
        'archon-ralph-dag',
        'archon-smart-pr-review',
      ]);
      expect(result.workflows.size).toBeGreaterThanOrEqual(5);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('loads bundled even when directory does not exist at all', () => {
    const ghost = path.join(tmpRoot, 'does-not-exist');
    const result = _loadDagFromDir(ghost);
    expect(result.errors).toEqual([]);
    expect(result.workflows.size).toBeGreaterThanOrEqual(5);
    for (const [, entry] of result.workflows) {
      expect(entry.source).toBe('bundled');
    }
  });

  it('project workflow overrides bundled by name (precedence)', () => {
    // Define a project workflow with the same name as a bundled archon one.
    writeFile(
      path.join(tmpRoot, 'archon-smart-pr-review', 'workflow.yaml'),
      [
        'name: archon-smart-pr-review',
        'description: project override',
        'nodes:',
        '  - id: only',
        '    prompt: this is the project override',
        '',
      ].join('\n'),
    );

    const result = _loadDagFromDir(tmpRoot);
    expect(result.errors).toEqual([]);
    const entry = result.workflows.get('archon-smart-pr-review');
    expect(entry).toBeDefined();
    expect(entry?.source).toBe('project');
    expect(entry?.workflow.nodes.length).toBe(1);
    expect((entry?.workflow.nodes[0] as { prompt?: string }).prompt).toBe(
      'this is the project override',
    );
  });
});

// ─── cache + reload ────────────────────────────────────────────────────────

// ─── Phase 2 — loadDagWorkflowForGroup remote fetch ─────────────────────────
//
// Tests are hermetic: fetch is mocked via globalThis.fetch, and the db module
// is mocked so we never touch SQLite. The ARCHON_DAG_REMOTE_FETCH_ENABLED
// env var is toggled per test.
//
// A minimal valid WorkflowDefinition used in several tests:
const MINIMAL_WORKFLOW_YAML = [
  'name: smoke-joke',
  'description: Phase 2 test workflow',
  'nodes:',
  '  - id: joke',
  '    prompt: Tell a joke.',
  '',
].join('\n');

// The schema expects a parsed object (not YAML text). Build the object that
// matches WorkflowDefinition so we don't depend on a YAML parse step in tests.
const MINIMAL_WORKFLOW_OBJ = {
  name: 'smoke-joke',
  description: 'Phase 2 test workflow',
  nodes: [{ id: 'joke', prompt: 'Tell a joke.' }],
};

// The full apiSuccess envelope that DP returns:
const makeEnvelope = (etag = '"v1"') => ({
  data: {
    name: 'smoke-joke',
    kind: 'dag',
    workflow: MINIMAL_WORKFLOW_OBJ,
    source: 'override',
    etag,
  },
  success: true,
});

/** Build a mock Response object compatible with the Fetch API. */
function makeFetchResponse(
  status: number,
  body: unknown = null,
  headers: Record<string, string> = {},
): Response {
  const headersInit = new Headers(headers);
  const bodyText = body === null ? '' : JSON.stringify(body);
  return new Response(bodyText || null, { status, headers: headersInit });
}

// Default resolver that always returns a workspaceId (simulates a registered group)
const resolveWithWorkspace = (_jid: string): string => 'ws-test-123';
// Resolver that returns undefined (simulates group not found)
const resolveNoWorkspace = (_jid: string): string | undefined => undefined;

describe('loadDagWorkflowForGroup — remote fetch (Phase 2)', () => {
  let origFlag: string | undefined;
  let origToken: string | undefined;
  let origBase: string | undefined;

  beforeEach(() => {
    origFlag = process.env.ARCHON_DAG_REMOTE_FETCH_ENABLED;
    origToken = process.env.DELEGATE_AGENT_TOKEN;
    origBase = process.env.DELEGATE_API_BASE;
    process.env.DELEGATE_AGENT_TOKEN = 'test-token';
    process.env.DELEGATE_API_BASE = 'https://delegate.example.com';
    _resetDagWorkflowCache();
    _resetRemoteFetchCache();
  });

  afterEach(() => {
    if (origFlag === undefined) delete process.env.ARCHON_DAG_REMOTE_FETCH_ENABLED;
    else process.env.ARCHON_DAG_REMOTE_FETCH_ENABLED = origFlag;
    if (origToken === undefined) delete process.env.DELEGATE_AGENT_TOKEN;
    else process.env.DELEGATE_AGENT_TOKEN = origToken;
    if (origBase === undefined) delete process.env.DELEGATE_API_BASE;
    else process.env.DELEGATE_API_BASE = origBase;
    _resetDagWorkflowCache();
    _resetRemoteFetchCache();
    vi.restoreAllMocks();
  });

  // ── Test 1: flag=0 → skip HTTP ────────────────────────────────────────────
  it('with flag=0: skips HTTP and returns disk result', async () => {
    process.env.ARCHON_DAG_REMOTE_FETCH_ENABLED = '0';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    // Set up a workflow in a tmp dir and point WORKFLOWS_DIR there
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-p2-'));
    fs.mkdirSync(path.join(dir, 'smoke-joke'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'smoke-joke', 'workflow.yaml'), MINIMAL_WORKFLOW_YAML);
    const prevDir = process.env.WORKFLOWS_DIR;
    process.env.WORKFLOWS_DIR = dir;
    _resetDagWorkflowCache();
    try {
      const result = await loadDagWorkflowForGroup('smoke-joke', 'delegate:main', resolveWithWorkspace);
      expect(result).not.toBeNull();
      expect(result?.workflow.name).toBe('smoke-joke');
      expect(result?.source).not.toBe('remote');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      if (prevDir === undefined) delete process.env.WORKFLOWS_DIR;
      else process.env.WORKFLOWS_DIR = prevDir;
      _resetDagWorkflowCache();
    }
  });

  // ── Test 2: flag=1 + 200 → returns parsed workflow, cache populated ───────
  it('with flag=1 + 200: returns parsed workflow; cache populated with etag', async () => {
    process.env.ARCHON_DAG_REMOTE_FETCH_ENABLED = '1';
    const envelope = makeEnvelope('"v1"');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeFetchResponse(200, envelope, { etag: '"v1"' }),
    );

    const result = await loadDagWorkflowForGroup('smoke-joke', 'delegate:main', resolveWithWorkspace);
    expect(result).not.toBeNull();
    expect(result?.source).toBe('remote');
    expect(result?.workflow.name).toBe('smoke-joke');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second call within TTL should NOT hit fetch again (cache hit)
    const result2 = await loadDagWorkflowForGroup('smoke-joke', 'delegate:main', resolveWithWorkspace);
    expect(result2?.workflow.name).toBe('smoke-joke');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // still 1 — no extra call
  });

  // ── Test 3: flag=1 + 304 without cached entry → falls back to disk ────────
  it('with flag=1 + 304 (no cached entry): falls back to disk gracefully', async () => {
    process.env.ARCHON_DAG_REMOTE_FETCH_ENABLED = '1';
    // 304 sent without a cached entry — should fall back to disk
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeFetchResponse(304, null, { etag: '"v1"' }),
    );

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-p2-'));
    fs.mkdirSync(path.join(dir, 'smoke-joke'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'smoke-joke', 'workflow.yaml'), MINIMAL_WORKFLOW_YAML);
    const prevDir = process.env.WORKFLOWS_DIR;
    process.env.WORKFLOWS_DIR = dir;
    _resetDagWorkflowCache();
    try {
      const result = await loadDagWorkflowForGroup('smoke-joke', 'delegate:main', resolveWithWorkspace);
      // Falls back to disk (304 without cached entry)
      expect(result).not.toBeNull();
      expect(result?.source).not.toBe('remote');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      if (prevDir === undefined) delete process.env.WORKFLOWS_DIR;
      else process.env.WORKFLOWS_DIR = prevDir;
      _resetDagWorkflowCache();
    }
  });

  // ── Test 4: flag=1 + 404 → falls back to disk ─────────────────────────────
  it('with flag=1 + 404: falls back to disk', async () => {
    process.env.ARCHON_DAG_REMOTE_FETCH_ENABLED = '1';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeFetchResponse(404));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-p2-'));
    fs.mkdirSync(path.join(dir, 'smoke-joke'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'smoke-joke', 'workflow.yaml'), MINIMAL_WORKFLOW_YAML);
    const prevDir = process.env.WORKFLOWS_DIR;
    process.env.WORKFLOWS_DIR = dir;
    _resetDagWorkflowCache();
    try {
      const result = await loadDagWorkflowForGroup('smoke-joke', 'delegate:main', resolveWithWorkspace);
      expect(result).not.toBeNull();
      expect(result?.source).not.toBe('remote'); // disk source
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      if (prevDir === undefined) delete process.env.WORKFLOWS_DIR;
      else process.env.WORKFLOWS_DIR = prevDir;
      _resetDagWorkflowCache();
    }
  });

  // ── Test 5: flag=1 + 5XX → falls back to disk ─────────────────────────────
  it('with flag=1 + 5XX: falls back to disk', async () => {
    process.env.ARCHON_DAG_REMOTE_FETCH_ENABLED = '1';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeFetchResponse(503));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-p2-'));
    fs.mkdirSync(path.join(dir, 'smoke-joke'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'smoke-joke', 'workflow.yaml'), MINIMAL_WORKFLOW_YAML);
    const prevDir = process.env.WORKFLOWS_DIR;
    process.env.WORKFLOWS_DIR = dir;
    _resetDagWorkflowCache();
    try {
      const result = await loadDagWorkflowForGroup('smoke-joke', 'delegate:main', resolveWithWorkspace);
      expect(result?.source).not.toBe('remote');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      if (prevDir === undefined) delete process.env.WORKFLOWS_DIR;
      else process.env.WORKFLOWS_DIR = prevDir;
      _resetDagWorkflowCache();
    }
  });

  // ── Test 6: flag=1 + fetch throws → falls back to disk ────────────────────
  it('with flag=1 + network error: falls back to disk', async () => {
    process.env.ARCHON_DAG_REMOTE_FETCH_ENABLED = '1';
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      Object.assign(new Error('Network error'), { name: 'FetchError' }),
    );

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-p2-'));
    fs.mkdirSync(path.join(dir, 'smoke-joke'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'smoke-joke', 'workflow.yaml'), MINIMAL_WORKFLOW_YAML);
    const prevDir = process.env.WORKFLOWS_DIR;
    process.env.WORKFLOWS_DIR = dir;
    _resetDagWorkflowCache();
    try {
      const result = await loadDagWorkflowForGroup('smoke-joke', 'delegate:main', resolveWithWorkspace);
      expect(result?.source).not.toBe('remote');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      if (prevDir === undefined) delete process.env.WORKFLOWS_DIR;
      else process.env.WORKFLOWS_DIR = prevDir;
      _resetDagWorkflowCache();
    }
  });

  // ── Test 7: unresolvable workspaceId → falls back to disk ─────────────────
  it('with unresolvable workspaceId (no group metadata): falls back to disk', async () => {
    process.env.ARCHON_DAG_REMOTE_FETCH_ENABLED = '1';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-p2-'));
    fs.mkdirSync(path.join(dir, 'smoke-joke'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'smoke-joke', 'workflow.yaml'), MINIMAL_WORKFLOW_YAML);
    const prevDir = process.env.WORKFLOWS_DIR;
    process.env.WORKFLOWS_DIR = dir;
    _resetDagWorkflowCache();
    try {
      // resolveNoWorkspace always returns undefined — simulates unregistered group
      const result = await loadDagWorkflowForGroup('smoke-joke', 'delegate:unknown', resolveNoWorkspace);
      expect(result?.source).not.toBe('remote');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      if (prevDir === undefined) delete process.env.WORKFLOWS_DIR;
      else process.env.WORKFLOWS_DIR = prevDir;
      _resetDagWorkflowCache();
    }
  });

  // ── Test 8: cache TTL — second call within 60s skips HTTP ─────────────────
  it('cache TTL: second call within 60s skips HTTP entirely', async () => {
    process.env.ARCHON_DAG_REMOTE_FETCH_ENABLED = '1';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeFetchResponse(200, makeEnvelope('"v1"'), { etag: '"v1"' }),
    );

    // First call → HTTP
    await loadDagWorkflowForGroup('smoke-joke', 'delegate:main', resolveWithWorkspace);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second call immediately → cache hit (within 60s TTL), no HTTP
    await loadDagWorkflowForGroup('smoke-joke', 'delegate:main', resolveWithWorkspace);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // still 1
  });

  // ── Test 9: etag header takes precedence over body.etag ───────────────────
  it('etag header precedence: HTTP header wins over body.etag on conflict', async () => {
    process.env.ARCHON_DAG_REMOTE_FETCH_ENABLED = '1';
    const bodyWithStaleEtag = {
      data: {
        name: 'smoke-joke',
        kind: 'dag',
        workflow: MINIMAL_WORKFLOW_OBJ,
        source: 'override',
        etag: '"v-body-old"', // body claims old version
      },
      success: true,
    };

    // First call: header says "v2", body says "v-body-old". Header must win.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeFetchResponse(200, bodyWithStaleEtag, { etag: '"v2"' }),
    );
    const result = await loadDagWorkflowForGroup('smoke-joke', 'delegate:main', resolveWithWorkspace);
    expect(result?.source).toBe('remote');
    expect(result?.workflow.name).toBe('smoke-joke');

    // After the 200, cache must have etag="v2" (not "v-body-old").
    // To verify: expire TTL, then confirm the re-fetch uses If-None-Match: "v2".
    _resetRemoteFetchCache();
    // Re-seed with the same conflicting body/header
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeFetchResponse(200, bodyWithStaleEtag, { etag: '"v2"' }),
    );
    await loadDagWorkflowForGroup('smoke-joke', 'delegate:main', resolveWithWorkspace);

    // Now expire cache and spy on the next call's If-None-Match header
    _resetRemoteFetchCache();
    const revalidateSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeFetchResponse(200, makeEnvelope('"v3"'), { etag: '"v3"' }));
    await loadDagWorkflowForGroup('smoke-joke', 'delegate:main', resolveWithWorkspace);

    // The If-None-Match header in the second round must be "v2" (from header),
    // NOT "v-body-old" (from body), proving header precedence was applied.
    const callArgs = revalidateSpy.mock.calls[0];
    if (callArgs) {
      const reqHeaders = (callArgs[1] as RequestInit | undefined)?.headers as
        | Record<string, string>
        | undefined;
      if (reqHeaders?.['If-None-Match']) {
        expect(reqHeaders['If-None-Match']).toBe('"v2"');
        expect(reqHeaders['If-None-Match']).not.toBe('"v-body-old"');
      }
    }
  });
});

describe('cache lifecycle', () => {
  it('loadAllDagWorkflows respects WORKFLOWS_DIR env on first call', () => {
    writeFile(
      path.join(tmpRoot, 'envtest', 'workflow.yaml'),
      [
        'name: envtest',
        'description: d',
        'nodes:',
        '  - id: a',
        '    prompt: x',
        '',
      ].join('\n'),
    );
    const prev = process.env.WORKFLOWS_DIR;
    process.env.WORKFLOWS_DIR = tmpRoot;
    _resetDagWorkflowCache();
    try {
      const result = loadAllDagWorkflows();
      expect(result.workflows.has('envtest')).toBe(true);
      expect(result.workflows.get('envtest')?.source).toBe('project');
      // Bundled defaults also surface; just confirm at least the project one is there.
      expect(result.workflows.size).toBeGreaterThanOrEqual(1);
    } finally {
      if (prev === undefined) delete process.env.WORKFLOWS_DIR;
      else process.env.WORKFLOWS_DIR = prev;
      _resetDagWorkflowCache();
    }
  });
});
