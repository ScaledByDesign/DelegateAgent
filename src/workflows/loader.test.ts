import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _loadFromDir } from './loader.js';
import { WorkflowSchemaError } from './types.js';

// ─── helpers ────────────────────────────────────────────────────────────────

let tmpRoot: string;

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workflows-test-'));
}

function writeFile(p: string, contents: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents, 'utf-8');
}

function validConfigYaml(): string {
  return [
    'name: "Test Workflow"',
    'description: "for tests"',
    'has_result: true',
    'result_criteria: "all phases done"',
    'on_result_found: "stop_all"',
    'launch_template: "Phase 1 starts here."',
    'phase_order:',
    '  - "01_alpha"',
    '  - "02_beta"',
    '',
  ].join('\n');
}

function validPhaseYaml(id: string, name: string): string {
  return [
    `id: "${id}"`,
    `name: "${name}"`,
    'description: |',
    `  Description for ${id}.`,
    'done_definitions:',
    '  - "Done 1"',
    '  - "Done 2"',
    '  - "Done 3"',
    'working_directory: "."',
    'additional_notes: "notes"',
    'outputs:',
    '  - "output 1"',
    'next_steps:',
    '  - "next step"',
    '',
  ].join('\n');
}

beforeEach(() => {
  tmpRoot = makeTmpRoot();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ─── tests ──────────────────────────────────────────────────────────────────

describe('workflow loader — happy path', () => {
  it('loads a valid split-layout workflow', () => {
    const wfDir = path.join(tmpRoot, 'demo');
    writeFile(path.join(wfDir, 'workflow.yaml'), validConfigYaml());
    writeFile(
      path.join(wfDir, 'phases', '01_alpha.yaml'),
      validPhaseYaml('01_alpha', 'Alpha'),
    );
    writeFile(
      path.join(wfDir, 'phases', '02_beta.yaml'),
      validPhaseYaml('02_beta', 'Beta'),
    );

    const m = _loadFromDir(tmpRoot);
    expect(m.size).toBe(1);
    const wf = m.get('demo');
    expect(wf).toBeDefined();
    expect(wf!.config.name).toBe('Test Workflow');
    expect(wf!.config.phase_order).toEqual(['01_alpha', '02_beta']);
    expect(wf!.phases).toHaveLength(2);
    expect(wf!.phases[0].id).toBe('01_alpha');
    expect(wf!.phases[1].id).toBe('02_beta');
    expect(wf!.phases[0].done_definitions).toHaveLength(3);
  });

  it('returns empty map when workflows dir is missing', () => {
    const m = _loadFromDir(path.join(tmpRoot, 'does-not-exist'));
    expect(m.size).toBe(0);
  });

  it('skips non-directory entries at the top level', () => {
    writeFile(path.join(tmpRoot, 'README.md'), '# not a workflow');
    const wfDir = path.join(tmpRoot, 'demo');
    writeFile(path.join(wfDir, 'workflow.yaml'), validConfigYaml());
    writeFile(
      path.join(wfDir, 'phases', '01_alpha.yaml'),
      validPhaseYaml('01_alpha', 'Alpha'),
    );
    writeFile(
      path.join(wfDir, 'phases', '02_beta.yaml'),
      validPhaseYaml('02_beta', 'Beta'),
    );

    const m = _loadFromDir(tmpRoot);
    expect(Array.from(m.keys())).toEqual(['demo']);
  });
});

describe('workflow loader — schema drift', () => {
  it('throws when workflow.yaml is missing', () => {
    const wfDir = path.join(tmpRoot, 'demo');
    writeFile(
      path.join(wfDir, 'phases', '01_alpha.yaml'),
      validPhaseYaml('01_alpha', 'Alpha'),
    );
    expect(() => _loadFromDir(tmpRoot)).toThrow(WorkflowSchemaError);
  });

  it('throws when phases/ directory is missing', () => {
    const wfDir = path.join(tmpRoot, 'demo');
    writeFile(path.join(wfDir, 'workflow.yaml'), validConfigYaml());
    expect(() => _loadFromDir(tmpRoot)).toThrow(/missing phases\/ directory/);
  });

  it('throws when phase file has missing required field (done_definitions)', () => {
    const wfDir = path.join(tmpRoot, 'demo');
    writeFile(path.join(wfDir, 'workflow.yaml'), validConfigYaml());
    // phase missing done_definitions
    writeFile(
      path.join(wfDir, 'phases', '01_alpha.yaml'),
      [
        'id: "01_alpha"',
        'name: "Alpha"',
        'description: "x"',
        'working_directory: "."',
        'additional_notes: "n"',
        'outputs: []',
        'next_steps: []',
        '',
      ].join('\n'),
    );
    writeFile(
      path.join(wfDir, 'phases', '02_beta.yaml'),
      validPhaseYaml('02_beta', 'Beta'),
    );
    expect(() => _loadFromDir(tmpRoot)).toThrow(/done_definitions/);
  });

  it('throws when phase file has an unknown extra field', () => {
    const wfDir = path.join(tmpRoot, 'demo');
    writeFile(path.join(wfDir, 'workflow.yaml'), validConfigYaml());
    // Inject an unknown top-level key in the phase file; loader rejects.
    writeFile(
      path.join(wfDir, 'phases', '01_alpha.yaml'),
      validPhaseYaml('01_alpha', 'Alpha') + 'unexpected_field: "boom"\n',
    );
    writeFile(
      path.join(wfDir, 'phases', '02_beta.yaml'),
      validPhaseYaml('02_beta', 'Beta'),
    );
    expect(() => _loadFromDir(tmpRoot)).toThrow(/unknown field/);
  });

  it('throws on malformed YAML', () => {
    const wfDir = path.join(tmpRoot, 'demo');
    writeFile(
      path.join(wfDir, 'workflow.yaml'),
      'name: "X"\n  bad: indent: here:\n - oops',
    );
    writeFile(
      path.join(wfDir, 'phases', '01_alpha.yaml'),
      validPhaseYaml('01_alpha', 'Alpha'),
    );
    expect(() => _loadFromDir(tmpRoot)).toThrow(WorkflowSchemaError);
  });

  it('throws when phase_order references a phase id with no file', () => {
    const wfDir = path.join(tmpRoot, 'demo');
    writeFile(path.join(wfDir, 'workflow.yaml'), validConfigYaml());
    // Only one phase file, but phase_order has two ids
    writeFile(
      path.join(wfDir, 'phases', '01_alpha.yaml'),
      validPhaseYaml('01_alpha', 'Alpha'),
    );
    expect(() => _loadFromDir(tmpRoot)).toThrow(/no matching phase file/);
  });

  it('throws when a phase file is orphaned (not in phase_order)', () => {
    const wfDir = path.join(tmpRoot, 'demo');
    writeFile(path.join(wfDir, 'workflow.yaml'), validConfigYaml());
    writeFile(
      path.join(wfDir, 'phases', '01_alpha.yaml'),
      validPhaseYaml('01_alpha', 'Alpha'),
    );
    writeFile(
      path.join(wfDir, 'phases', '02_beta.yaml'),
      validPhaseYaml('02_beta', 'Beta'),
    );
    writeFile(
      path.join(wfDir, 'phases', '99_orphan.yaml'),
      validPhaseYaml('99_orphan', 'Orphan'),
    );
    expect(() => _loadFromDir(tmpRoot)).toThrow(/not listed in phase_order/);
  });

  it('throws when phase_order has duplicate ids', () => {
    const wfDir = path.join(tmpRoot, 'demo');
    writeFile(
      path.join(wfDir, 'workflow.yaml'),
      validConfigYaml().replace(
        'phase_order:\n  - "01_alpha"\n  - "02_beta"',
        'phase_order:\n  - "01_alpha"\n  - "01_alpha"',
      ),
    );
    writeFile(
      path.join(wfDir, 'phases', '01_alpha.yaml'),
      validPhaseYaml('01_alpha', 'Alpha'),
    );
    expect(() => _loadFromDir(tmpRoot)).toThrow(/duplicate phase id/);
  });
});

describe('workflow loader — bug-fix workflow (real fixture)', () => {
  it('loads the shipped bug-fix workflow from the repo root', () => {
    // The test runs from the DelegateAgent repo root; the shipped workflows/
    // dir is loadable as-is.
    const repoRoot = path.resolve(__dirname, '..', '..');
    const workflowsDir = path.join(repoRoot, 'workflows');
    if (!fs.existsSync(workflowsDir)) {
      // Skip rather than fail in environments missing the fixture.
      return;
    }
    const m = _loadFromDir(workflowsDir);
    const bugFix = m.get('bug-fix');
    expect(bugFix).toBeDefined();
    expect(bugFix!.phases).toHaveLength(4);
    expect(bugFix!.config.phase_order).toEqual([
      '01_reproduce',
      '02_locate_root_cause',
      '03_fix_and_test',
      '04_verify_and_commit',
    ]);
    for (const p of bugFix!.phases) {
      expect(p.done_definitions.length).toBeGreaterThanOrEqual(3);
    }
  });
});
