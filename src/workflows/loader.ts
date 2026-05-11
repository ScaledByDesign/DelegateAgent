/**
 * Hephaestus Port 2 — workflow loader.
 *
 * Walks the `workflows/<name>/` directories, parses both the top-level
 * `workflow.yaml` and the per-phase `phases/NN_<id>.yaml` files, validates them
 * against the schemas in `./types.ts`, and returns a unified
 * `Workflow { config, phases: Phase[] }` object per workflow.
 *
 * Module-level cache is populated by `loadAllWorkflows()` and refreshed by
 * `reloadWorkflows()` (used by the `POST /workflows/reload` admin endpoint).
 *
 * Failures: schema drift on ANY workflow throws `WorkflowSchemaError` from
 * `loadAllWorkflows()` — fail fast so a broken workflow surfaces at startup
 * instead of half-loading. The reload endpoint catches this and returns 400
 * with the error message.
 */

import * as fs from 'fs';
import * as path from 'path';

import jsYaml from 'js-yaml';

import { logger } from '../logger.js';
import {
  validatePhase,
  validateWorkflowConfig,
  WorkflowSchemaError,
  type Phase,
  type Workflow,
} from './types.js';

/** Directory containing all workflows. Override via `WORKFLOWS_DIR` env var.
 *  Resolved lazily so test setups that mutate `process.env` after import still
 *  take effect. */
function workflowsDir(): string {
  return process.env.WORKFLOWS_DIR || path.resolve(process.cwd(), 'workflows');
}

let _cache: Map<string, Workflow> | null = null;

/** Returns the cached map, loading on first call. */
export function loadAllWorkflows(): Map<string, Workflow> {
  if (_cache) return _cache;
  _cache = doLoad(workflowsDir());
  return _cache;
}

/** Look up a single workflow by directory name. Triggers initial load if needed. */
export function loadWorkflow(name: string): Workflow | null {
  const m = loadAllWorkflows();
  return m.get(name) ?? null;
}

/** Re-run the loader, replacing the cache. Used by the hot-reload endpoint. */
export function reloadWorkflows(): {
  count: number;
  names: string[];
} {
  const fresh = doLoad(workflowsDir());
  _cache = fresh;
  const names = Array.from(fresh.keys()).sort();
  logger.info({ count: fresh.size, names }, 'workflows reloaded');
  return { count: fresh.size, names };
}

/** Test-only: blow away the module cache so tests can re-load fixture dirs. */
export function _resetWorkflowCache(): void {
  _cache = null;
}

/** Test-only: load from an arbitrary directory. */
export function _loadFromDir(dir: string): Map<string, Workflow> {
  return doLoad(dir);
}

// ─── internals ──────────────────────────────────────────────────────────────

function doLoad(rootDir: string): Map<string, Workflow> {
  const result = new Map<string, Workflow>();
  if (!fs.existsSync(rootDir)) {
    logger.warn(
      { rootDir },
      'workflows directory does not exist — returning empty registry',
    );
    return result;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (err) {
    logger.error({ err, rootDir }, 'failed to read workflows directory');
    return result;
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const name = ent.name;
    const dir = path.join(rootDir, name);
    const workflow = loadOneWorkflow(name, dir);
    result.set(name, workflow);
  }
  return result;
}

function loadOneWorkflow(name: string, dir: string): Workflow {
  const cfgFile = path.join(dir, 'workflow.yaml');
  const phasesDir = path.join(dir, 'phases');
  if (!fs.existsSync(cfgFile)) {
    throw new WorkflowSchemaError(
      relPath(cfgFile),
      '<file>',
      'missing workflow.yaml',
    );
  }
  if (!fs.existsSync(phasesDir)) {
    throw new WorkflowSchemaError(
      relPath(phasesDir),
      '<dir>',
      'missing phases/ directory',
    );
  }

  // Parse the top-level config.
  const cfgRaw = readYaml(cfgFile);
  const config = validateWorkflowConfig(cfgRaw, relPath(cfgFile));

  // Parse each phase file. We sort by filename so 01_*, 02_*, ... load in
  // numeric order regardless of fs.readdir ordering.
  const phaseEntries = fs
    .readdirSync(phasesDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
    .map((e) => e.name)
    .sort();
  const phasesById = new Map<string, Phase>();
  for (const fname of phaseEntries) {
    const fpath = path.join(phasesDir, fname);
    const raw = readYaml(fpath);
    const phase = validatePhase(raw, relPath(fpath));
    if (phasesById.has(phase.id)) {
      throw new WorkflowSchemaError(
        relPath(fpath),
        'id',
        `duplicate phase id "${phase.id}" — already declared in another file`,
      );
    }
    phasesById.set(phase.id, phase);
  }

  // Reconcile config.phase_order against actual phase files.
  const orderedPhases: Phase[] = [];
  for (let i = 0; i < config.phase_order.length; i++) {
    const id = config.phase_order[i];
    const p = phasesById.get(id);
    if (!p) {
      throw new WorkflowSchemaError(
        relPath(cfgFile),
        `phase_order[${i}]`,
        `references phase "${id}" but no matching phase file found in ${relPath(phasesDir)}`,
      );
    }
    orderedPhases.push(p);
  }
  // Reject orphan phase files (defined but not referenced) so the workflow
  // shape stays self-consistent.
  for (const id of phasesById.keys()) {
    if (!config.phase_order.includes(id)) {
      throw new WorkflowSchemaError(
        relPath(cfgFile),
        'phase_order',
        `phase "${id}" exists as a file but is not listed in phase_order`,
      );
    }
  }

  logger.info(
    { workflow: name, phaseCount: orderedPhases.length },
    'workflow loaded',
  );
  return { config, phases: orderedPhases };
}

function readYaml(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    throw new WorkflowSchemaError(
      relPath(file),
      '<file>',
      `cannot read file: ${(err as Error).message}`,
    );
  }
  try {
    return jsYaml.load(text);
  } catch (err) {
    throw new WorkflowSchemaError(
      relPath(file),
      '<yaml>',
      `malformed YAML: ${(err as Error).message}`,
    );
  }
}

function relPath(p: string): string {
  // Try to render a path relative to cwd when possible; this is purely cosmetic
  // so error messages aren't 200 chars of /Volumes/... noise.
  const rel = path.relative(process.cwd(), p);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  return p;
}
