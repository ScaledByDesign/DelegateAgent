import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _loadDagFromDir,
  _resetDagWorkflowCache,
  loadAllDagWorkflows,
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
