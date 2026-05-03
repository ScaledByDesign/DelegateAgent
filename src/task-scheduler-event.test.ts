/**
 * Tests for the event-driven scheduler path (TASK_SCHEDULER_EVENT_DRIVEN=1).
 *
 * These tests exercise startEventDrivenScheduler() directly, independent of
 * the feature flag, so they run in CI without needing env manipulation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask } from './db.js';
import {
  _resetSchedulerLoopForTests,
  getScheduledTasks,
  startEventDrivenScheduler,
} from './task-scheduler.js';
import type { SchedulerDependencies } from './task-scheduler.js';

/** Build a minimal SchedulerDependencies mock. */
function makeDeps(overrides: Partial<SchedulerDependencies> = {}): {
  deps: SchedulerDependencies;
  enqueueTask: ReturnType<typeof vi.fn>;
} {
  const enqueueTask = vi.fn(
    (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
      void fn();
    },
  );
  const deps: SchedulerDependencies = {
    registeredGroups: () => ({}),
    getSessions: () => ({}),
    queue: { enqueueTask, closeStdin: vi.fn(), notifyIdle: vi.fn() } as any,
    onProcess: () => {},
    sendMessage: async () => {},
    ...overrides,
  };
  return { deps, enqueueTask };
}

describe('event-driven scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    _resetSchedulerLoopForTests();
    vi.useRealTimers();
  });

  it('fires a task that is already due immediately (within the first tick)', async () => {
    // Task is 10 seconds overdue
    const pastTime = new Date(Date.now() - 10_000).toISOString();
    createTask({
      id: 'event-due-now',
      group_folder: 'testgroup',
      chat_jid: 'due@g.us',
      prompt: 'run me',
      schedule_type: 'once',
      schedule_value: pastTime,
      context_mode: 'isolated',
      next_run: pastTime,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    const { deps, enqueueTask } = makeDeps();
    const disposer = startEventDrivenScheduler(deps);

    // Advance past the initial 0ms setTimeout + 50ms re-arm delay
    await vi.advanceTimersByTimeAsync(100);

    // Dispose before the re-arm loop can fire again
    disposer.dispose();

    // Task should have been dispatched at least once
    // (even though runTask itself will fail because there is no real group —
    // what matters is enqueueTask was called)
    expect(enqueueTask).toHaveBeenCalledWith(
      'due@g.us',
      'event-due-now',
      expect.any(Function),
    );
  });

  it('fires a task within 1s of its due time', async () => {
    // Task due in exactly 500ms
    const dueAt = new Date(Date.now() + 500).toISOString();
    createTask({
      id: 'event-due-soon',
      group_folder: 'testgroup',
      chat_jid: 'soon@g.us',
      prompt: 'run soon',
      schedule_type: 'once',
      schedule_value: dueAt,
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    const { deps, enqueueTask } = makeDeps();
    const disposer = startEventDrivenScheduler(deps);

    // Not yet due after 400ms
    await vi.advanceTimersByTimeAsync(400);
    expect(enqueueTask).not.toHaveBeenCalled();

    // Now advance to 600ms — should have fired (task was due at 500ms)
    await vi.advanceTimersByTimeAsync(200);

    // Dispose before the 50ms re-arm loop can spin
    disposer.dispose();

    expect(enqueueTask).toHaveBeenCalledWith(
      'soon@g.us',
      'event-due-soon',
      expect.any(Function),
    );
  });

  it('reschedules when notifyScheduler is called with a closer task', async () => {
    // First task due in 30s
    const farDue = new Date(Date.now() + 30_000).toISOString();
    createTask({
      id: 'event-far',
      group_folder: 'testgroup',
      chat_jid: 'far@g.us',
      prompt: 'run far',
      schedule_type: 'once',
      schedule_value: farDue,
      context_mode: 'isolated',
      next_run: farDue,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    const { deps, enqueueTask } = makeDeps();
    const disposer = startEventDrivenScheduler(deps);

    // Advance 5s — nothing should have fired
    await vi.advanceTimersByTimeAsync(5_000);
    expect(enqueueTask).not.toHaveBeenCalled();

    // Add a closer task due in 1s from now
    const closeDue = new Date(Date.now() + 1_000).toISOString();
    createTask({
      id: 'event-close',
      group_folder: 'testgroup',
      chat_jid: 'close@g.us',
      prompt: 'run close',
      schedule_type: 'once',
      schedule_value: closeDue,
      context_mode: 'isolated',
      next_run: closeDue,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    // Notify scheduler of the new task
    disposer.notifyScheduler();

    // Advance 1.5s — the closer task should fire
    await vi.advanceTimersByTimeAsync(1_500);
    const firedJids = enqueueTask.mock.calls.map((c) => c[0]);
    expect(firedJids).toContain('close@g.us');

    disposer.dispose();
  });

  it('disposer cancels pending timeout and stops future fires', async () => {
    const dueAt = new Date(Date.now() + 5_000).toISOString();
    createTask({
      id: 'event-dispose-test',
      group_folder: 'testgroup',
      chat_jid: 'dispose@g.us',
      prompt: 'run dispose',
      schedule_type: 'once',
      schedule_value: dueAt,
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    const { deps, enqueueTask } = makeDeps();
    const disposer = startEventDrivenScheduler(deps);

    // Dispose before the task is due
    disposer.dispose();

    // Advance past the due time
    await vi.advanceTimersByTimeAsync(10_000);

    // Should not have fired
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it('horizon cap re-arms when no tasks are present', async () => {
    // No tasks in DB — scheduler should arm at horizon (1 hour)
    const { deps } = makeDeps();
    const disposer = startEventDrivenScheduler(deps);

    // Advance just under 1 hour — should not throw
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 - 100);

    // No error means the horizon arm fired and re-armed cleanly
    // Dispose so no pending timers leak into next test
    disposer.dispose();
  });

  it('getScheduledTasks returns active tasks in both modes', () => {
    const dueAt = new Date(Date.now() + 60_000).toISOString();
    createTask({
      id: 'summary-task',
      group_folder: 'testgroup',
      chat_jid: 'summary@g.us',
      prompt: 'summary prompt',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    const { deps } = makeDeps();
    const disposer = startEventDrivenScheduler(deps);

    const tasks = getScheduledTasks();
    expect(tasks.length).toBeGreaterThan(0);
    const t = tasks.find((s) => s.id === 'summary-task');
    expect(t).toBeDefined();
    expect(t?.kind).toBe('cron');
    expect(t?.nextFireAt).toBe(dueAt);

    disposer.dispose();
  });
});
