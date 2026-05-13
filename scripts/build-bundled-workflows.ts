// Phase 1.7 — bundled-defaults codegen.
//
// Reads every workflows/archon-*/workflow.yaml from the repo root, validates
// each through the Zod loader (parses YAML + enforces graph + secret-pattern
// invariants), and emits src/workflows/bundled-defaults.generated.ts — a
// typed map keyed by workflow name with the verbatim YAML text as the value.
//
// We embed raw YAML (not a pre-parsed object) so:
//   1. The runtime loader's single YAML to object to Zod pipeline stays canonical.
//   2. Bytes are deterministic across machines (js-yaml emit reorders keys).
//   3. PR diffs are human-readable.
//
// Output is gitignored. CI re-runs this script then asserts
// "git diff --exit-code" so a YAML change without "npm run prebuild" is
// caught before merge.
//
// Usage:
//   npx tsx scripts/build-bundled-workflows.ts
//   (or via npm run prebuild)

import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import jsYaml from 'js-yaml';

import { workflowDefinitionSchema } from '../src/workflows/schemas/index.js';

const ARCHON_PREFIX = 'archon-';

interface Entry {
  name: string;
  yaml: string;
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..');
  const workflowsDir = join(repoRoot, 'workflows');
  const outputPath = join(
    repoRoot,
    'src',
    'workflows',
    'bundled-defaults.generated.ts',
  );

  const entries: Entry[] = [];

  for (const ent of readdirSync(workflowsDir, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if (!ent.isDirectory()) continue;
    if (!ent.name.startsWith(ARCHON_PREFIX)) continue;

    const yamlPath = join(workflowsDir, ent.name, 'workflow.yaml');
    try {
      if (!statSync(yamlPath).isFile()) continue;
    } catch {
      console.warn(`[bundled-workflows] skipping ${ent.name} — no workflow.yaml`);
      continue;
    }

    const text = readFileSync(yamlPath, 'utf-8');
    // Validate at build time so a broken bundled workflow can never ship.
    const parsed = jsYaml.load(text);
    const result = workflowDefinitionSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('\n  ');
      throw new Error(
        `[bundled-workflows] ${yamlPath} failed schema validation:\n  ${issues}`,
      );
    }

    entries.push({ name: ent.name, yaml: text });
    console.log(
      `[bundled-workflows] validated ${ent.name} (${text.length} bytes, ${result.data.nodes.length} nodes)`,
    );
  }

  const body = generateOutput(entries);
  writeFileSync(outputPath, body, 'utf-8');
  console.log(
    `[bundled-workflows] wrote ${entries.length} entries → ${outputPath} (${body.length} bytes)`,
  );
}

function generateOutput(entries: Entry[]): string {
  const lines = [
    '// AUTO-GENERATED FILE — DO NOT EDIT BY HAND.',
    '//',
    '// Source: workflows/archon-*/workflow.yaml',
    '// Regenerate: npx tsx scripts/build-bundled-workflows.ts',
    '//',
    '// Wired into package.json as the prebuild step. CI runs the codegen +',
    '// asserts "git diff --exit-code" so YAML drift surfaces in PR review.',
    '// Gitignored — never commit this file.',
    '',
    '// Raw YAML text per bundled workflow name. Parsed lazily at run time by',
    '// src/workflows/dag-loader.ts when a workflow lookup misses the filesystem.',
    'export const BUNDLED_WORKFLOW_YAML: Readonly<Record<string, string>> = Object.freeze({',
  ];

  for (const { name, yaml } of entries) {
    // JSON.stringify produces a valid JS string literal — handles every
    // character (including backticks, ${, backslashes, control chars).
    lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(yaml)},`);
  }

  lines.push(
    '});',
    '',
    '/** List of bundled workflow names (for tests + diagnostics). */',
    'export const BUNDLED_WORKFLOW_NAMES: readonly string[] = Object.freeze(',
    '  Object.keys(BUNDLED_WORKFLOW_YAML),',
    ');',
    '',
  );

  return lines.join('\n');
}

main();
