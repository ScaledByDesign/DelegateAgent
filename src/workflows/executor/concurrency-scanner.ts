// Phase 2 — concurrency scanner.
//
// Periodic (default 5s) sweep of `pending` workflow_runs. For each pending
// run we try to claim a slot via `IWorkflowStore.claimRun(id, chat_jid, cap)`.
// If the claim succeeds (i.e. fewer than `cap` runs are currently `running`
// for that chat_jid), we kick off the executor for the run.
//
// The scanner is the SOLE bridge between "user submitted a workflow run via
// POST /workflows/:name/runs" (which creates a `pending` row) and "the
// executor actually starts." Production wires it into `src/index.ts` on
// boot; tests instantiate it directly and tick manually via `scanOnce()`.
//
// Architect Q2 constraints honored:
//   - SQLite-driven authoritative state (no in-memory queue)
//   - Configurable cap via PlatformSetting (passed in via `getCap()`)
//   - Cap keyed on chat_jid; null jids share their own bucket

import { logger } from '../../logger.js';
import type { WorkflowDefinition } from '../schemas/index.js';
import type {
  IWorkflowStore,
  WorkflowRunRow,
} from '../store/IWorkflowStore.js';
import { executeWorkflow, type ExecutorDeps } from './dag-executor.js';

export interface ConcurrencyScannerOptions {
  store: IWorkflowStore;
  /** Look up workflow definition by name (DA's dag-loader provides this). */
  resolveWorkflow: (name: string) => WorkflowDefinition | null;
  /** Executor wiring (event emitter etc.). */
  executorDeps: Omit<ExecutorDeps, 'store'>;
  /** Concurrency cap per chat_jid. Read from PlatformSetting on each tick. */
  getCap: () => number | Promise<number>;
  /** Tick interval in ms. Default 5000. */
  intervalMs?: number;
  /** Max pending rows considered per tick (prevents one tick from saturating).
   *  Default 50. */
  batchSize?: number;
}

export class ConcurrencyScanner {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = new Set<string>();
  private stopped = false;

  constructor(private readonly opts: ConcurrencyScannerOptions) {}

  /** Start the periodic sweep. Idempotent: calling twice has no effect. */
  start(): void {
    if (this.timer) return;
    const interval = this.opts.intervalMs ?? 5000;
    this.timer = setInterval(() => {
      void this.scanOnce().catch((err) => {
        logger.error({ err }, 'concurrency_scanner_tick_failed');
      });
    }, interval);
    // Don't keep the Node event loop alive just for this timer.
    this.timer.unref?.();
  }

  /** Stop the periodic sweep. Outstanding executor promises are NOT aborted —
   *  call signal.abort() at a higher level if you need to interrupt running
   *  work. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Single sweep: pull pending runs, try to claim slots, dispatch the
   * executor for each claim. Exported so tests can drive scans manually
   * without setting up a timer.
   *
   * Returns the list of run ids that were successfully claimed and dispatched
   * on this tick (useful for tests).
   */
  async scanOnce(): Promise<string[]> {
    if (this.stopped) return [];
    const batch = this.opts.batchSize ?? 50;
    const pending = this.opts.store.listRunsByStatus('pending', batch);
    if (pending.length === 0) return [];

    const cap = await this.opts.getCap();
    const dispatched: string[] = [];

    for (const run of pending) {
      if (this.inFlight.has(run.id)) continue;
      const claimed = this.opts.store.claimRun(run.id, run.chat_jid, cap);
      if (!claimed) {
        continue; // cap reached for this jid; try again next tick
      }
      dispatched.push(run.id);
      this.dispatchAsync(claimed).catch((err) => {
        logger.error(
          { err, runId: claimed.id },
          'concurrency_scanner_dispatch_crashed',
        );
      });
    }
    return dispatched;
  }

  private async dispatchAsync(run: WorkflowRunRow): Promise<void> {
    this.inFlight.add(run.id);
    try {
      const workflow = this.opts.resolveWorkflow(run.workflow_name);
      if (!workflow) {
        // No such workflow — mark failed so the row doesn't loop in pending forever.
        this.opts.store.updateRunStatus(run.id, {
          status: 'failed',
          metadata: {
            resolve_failed: `workflow '${run.workflow_name}' not found`,
          },
        });
        logger.error(
          { runId: run.id, workflow: run.workflow_name },
          'concurrency_scanner_workflow_not_found',
        );
        return;
      }
      await executeWorkflow(run.id, workflow, {
        ...this.opts.executorDeps,
        store: this.opts.store,
      });
    } finally {
      this.inFlight.delete(run.id);
    }
  }
}
