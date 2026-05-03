import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

// ---------------------------------------------------------------------------
// FLAG: TASK_SCHEDULER_EVENT_DRIVEN
//
// When set to "1", replaces the 60-second polling loop with an event-driven
// model that computes the exact next-fire time using cron-parser and uses a
// single setTimeout. CPU at idle drops significantly — the process wakes only
// when a task is actually due rather than every 60 seconds.
//
// Usage:
//   TASK_SCHEDULER_EVENT_DRIVEN=1 npm start
//   TASK_SCHEDULER_EVENT_DRIVEN=1 npm run dev
//
// The polling code path remains unchanged. Both paths coexist in this file.
// Set the flag per-droplet via the environment (e.g. in systemd unit or .env).
// Safe rollback: unset the flag → polling resumes immediately on next restart.
// ---------------------------------------------------------------------------
const EVENT_DRIVEN = process.env.TASK_SCHEDULER_EVENT_DRIVEN === '1';

// ---------------------------------------------------------------------------
// Max horizon cap (1 hour in ms).
//
// Rationale (§6.2 in the gap-closure plan):
//   (a) Clock drift accumulates over very long sleeps.
//   (b) Manual sqlite3 edits to the tasks table bypass notifyScheduler().
//   (c) DST transitions can shift cron expression semantics.
//
// We cap at min(60 min, 2× longest cron interval observed). Since all current
// production crons fire at most hourly, 60 min is the right ceiling.
// ---------------------------------------------------------------------------
const SCHEDULER_HORIZON_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// ScheduledTaskSummary — read-only snapshot exported for Phase 1 dashboard
// ---------------------------------------------------------------------------
export interface ScheduledTaskSummary {
  id: string;
  name: string;
  nextFireAt: string | null;
  kind: 'cron' | 'interval' | 'once';
}

// In-memory snapshot updated whenever the scheduler recomputes the queue.
// Kept in module scope so getScheduledTasks() works in both modes.
let _scheduledTasksSummary: ScheduledTaskSummary[] = [];

/**
 * Returns a read-only snapshot of all active scheduled tasks and their next
 * fire times. Safe to call from any code path (polling or event-driven).
 *
 * Phase 1 dashboard calls this from src/group-api.ts to populate
 * GET /admin/partials/scheduler.
 */
export function getScheduledTasks(): ScheduledTaskSummary[] {
  return _scheduledTasksSummary;
}

/** Refresh the in-memory summary from the DB. Called on every (re-)arm. */
function refreshSummary(): void {
  const tasks = getAllTasks().filter((t) => t.status === 'active');
  _scheduledTasksSummary = tasks.map((t) => ({
    id: t.id,
    name: t.prompt.slice(0, 80),
    nextFireAt: t.next_run,
    kind: t.schedule_type,
  }));
}

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        script: task.script || undefined,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

// ---------------------------------------------------------------------------
// Event-driven scheduler (behind TASK_SCHEDULER_EVENT_DRIVEN flag)
// ---------------------------------------------------------------------------

/**
 * Compute how many milliseconds until the task's next_run, or Infinity if
 * the task has no next_run set (once-only tasks that were never scheduled).
 */
function msUntilNextRun(task: ScheduledTask): number {
  if (!task.next_run) return Infinity;
  const delta = new Date(task.next_run).getTime() - Date.now();
  return delta; // May be negative (already due) — treated as 0 delay
}

export interface EventDrivenDisposer {
  /** Cancel any pending timeout and stop the scheduler. */
  dispose(): void;
  /**
   * Notify the scheduler that a task was added/updated so it can recompute
   * and re-arm the timer earlier if needed.
   */
  notifyScheduler(): void;
}

/**
 * Start the event-driven scheduler. Returns a disposer so callers can
 * cleanly shut down (and so tests can advance timers and then dispose).
 *
 * Algorithm:
 *   1. Load all active tasks from the DB.
 *   2. Find the task with the earliest next_run.
 *   3. Cap the wait at SCHEDULER_HORIZON_MS (1 hour) to guard against drift,
 *      DST changes, and out-of-band DB edits (see §6.2 rationale above).
 *   4. On timeout: dispatch all currently-due tasks, then recompute and re-arm.
 *   5. On notifyScheduler(): cancel current timeout, recompute, re-arm.
 *
 * Phase 4 integration (src/index.ts): after Phase 4 lands, wire as:
 *   import { startSchedulerLoop } from './task-scheduler.js';
 *   const disposer = startSchedulerLoop(deps);
 *   // then pass disposer.notifyScheduler to createTask / updateTask hooks
 */
export function startEventDrivenScheduler(
  deps: SchedulerDependencies,
): EventDrivenDisposer {
  let currentTimeout: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const arm = () => {
    if (disposed) return;
    if (currentTimeout !== null) {
      clearTimeout(currentTimeout);
      currentTimeout = null;
    }

    refreshSummary();

    const activeTasks = getAllTasks().filter(
      (t) => t.status === 'active' && t.next_run !== null,
    );

    if (activeTasks.length === 0) {
      // No active tasks — re-arm at horizon to pick up future additions
      // (if notifyScheduler() isn't called, we still wake up)
      logger.debug(
        { horizonMs: SCHEDULER_HORIZON_MS },
        'Event-driven scheduler: no active tasks, arming horizon wakeup',
      );
      currentTimeout = setTimeout(arm, SCHEDULER_HORIZON_MS);
      return;
    }

    // Find the minimum wait across all active tasks
    const msUntilEarliest = activeTasks.reduce((min, task) => {
      const ms = msUntilNextRun(task);
      return ms < min ? ms : min;
    }, Infinity);

    // Cap at horizon to guard against drift / out-of-band edits / DST
    const waitMs = Math.min(Math.max(0, msUntilEarliest), SCHEDULER_HORIZON_MS);

    logger.debug(
      { waitMs, taskCount: activeTasks.length },
      'Event-driven scheduler: armed',
    );

    currentTimeout = setTimeout(async () => {
      currentTimeout = null;
      if (disposed) return;

      try {
        const dueTasks = getDueTasks();
        if (dueTasks.length > 0) {
          logger.info(
            { count: dueTasks.length },
            'Event-driven: dispatching due tasks',
          );
        }
        for (const task of dueTasks) {
          const currentTask = getTaskById(task.id);
          if (!currentTask || currentTask.status !== 'active') continue;
          deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
            runTask(currentTask, deps),
          );
        }
      } catch (err) {
        logger.error(
          { err },
          'Event-driven scheduler: error dispatching tasks',
        );
      }

      // Re-arm for the next cycle.
      // Use a small minimum delay (50ms) before re-arming to prevent a tight
      // spin-loop when a task's status hasn't been updated yet (e.g. runTask
      // failed before calling updateTaskAfterRun and the task remains active
      // with a past next_run). This also yields the microtask queue so any
      // in-flight updateTaskAfterRun calls can commit before we re-read the DB.
      setTimeout(arm, 50);
    }, waitMs);
  };

  // Kick off
  arm();

  return {
    dispose() {
      disposed = true;
      if (currentTimeout !== null) {
        clearTimeout(currentTimeout);
        currentTimeout = null;
      }
      logger.debug('Event-driven scheduler disposed');
    },
    notifyScheduler() {
      if (disposed) return;
      logger.debug(
        'Event-driven scheduler: notified of task change, re-arming',
      );
      arm();
    },
  };
}

// ---------------------------------------------------------------------------
// Polling scheduler (default — unchanged code path)
// ---------------------------------------------------------------------------

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;

  if (EVENT_DRIVEN) {
    logger.info(
      'Scheduler loop started (event-driven mode — TASK_SCHEDULER_EVENT_DRIVEN=1)',
    );
    // Start event-driven path; expose notifyScheduler on module scope for
    // external callers (e.g. task API routes) to call when tasks change.
    _eventDrivenDisposer = startEventDrivenScheduler(deps);
    return;
  }

  logger.info('Scheduler loop started (polling mode)');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

// Module-level handle for the event-driven disposer, exposed so callers can
// call notifyScheduler() after task mutations without needing to thread the
// disposer through the entire call chain.
let _eventDrivenDisposer: EventDrivenDisposer | null = null;

/**
 * Notify the active event-driven scheduler that a task was added or updated.
 * No-op when running in polling mode or before the scheduler has started.
 *
 * Call this from any code path that creates/updates a scheduled task
 * (e.g. the task API route handler) to ensure the next fire time is
 * recomputed immediately rather than waiting for the next horizon wakeup.
 */
export function notifyScheduler(): void {
  _eventDrivenDisposer?.notifyScheduler();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
  if (_eventDrivenDisposer) {
    _eventDrivenDisposer.dispose();
    _eventDrivenDisposer = null;
  }
  _scheduledTasksSummary = [];
}
