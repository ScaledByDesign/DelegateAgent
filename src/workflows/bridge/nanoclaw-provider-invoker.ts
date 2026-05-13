// ─── Phase 2.5b — NanoClaw provider-bridge wiring ───
//
// Production `ProviderInvoker` that bridges the DAG executor's prompt/command/
// loop nodes to the existing container-runner (`runContainerAgent`).
//
// The DAG executor calls `invokeProvider(opts)`; in Phase 2 that threw
// `NOT YET WIRED`. Phase 2.5b replaces that default with this invoker so that
//   `provider: claude` and `provider: nanoclaw` nodes execute end-to-end via
// the same container path used by the live channel-poll agent.
//
// Surgical scope of this module:
//   - Read the WorkflowRunRow → `chat_jid` → `RegisteredGroup`.
//   - Translate `ProviderInvocationOptions` → `ContainerInput`.
//   - Call `runContainerAgent` with a `(proc, name) => void` hook so we can
//     forward `AbortSignal` from the executor into a `SIGTERM` on the
//     container child process.
//   - Surface `ContainerOutput.status === 'error'` as a thrown `Error`.
//   - Honour `freshContext` (loop nodes) by clearing `sessionId`.
//
// NOT in scope (intentional — future sub-phases):
//   - `src/ipc.ts` inbound IPC routing for workflow-spawned tasks.
//   - `src/container-runtime.ts` orphan cleanup hooks for workflow-run-spawned
//     containers (Phase 2.5c — sweep on agent restart).
//   - End-to-end test harness with a real docker image (Phase 2.5d).
//
// Single-writer invariants preserved:
//   - This invoker only READS the WorkflowRunRow (via `store.getRun`). It
//     never writes WorkflowRun state; that remains the executor's job.
//   - No TaskDelegation.status writes anywhere here.

import type { ChildProcess } from 'child_process';

import { logger } from '../../logger.js';
import {
  runContainerAgent,
  type ContainerInput,
  type ContainerOutput,
} from '../../container-runner.js';
import { getAllRegisteredGroups } from '../../db.js';
import type { RegisteredGroup } from '../../types.js';
import type { IWorkflowStore } from '../store/IWorkflowStore.js';
import type {
  ProviderInvocationOptions,
  ProviderInvocationResult,
  ProviderInvoker,
} from '../executor/provider-bridge.js';

export interface NanoClawInvokerDeps {
  store: IWorkflowStore;
  /** Container runner — overridable for tests. */
  runContainer?: typeof runContainerAgent;
  /** Group resolver by chat_jid — overridable for tests. */
  resolveGroup?: (chatJid: string) => RegisteredGroup | null;
}

const defaultResolveGroup = (chatJid: string): RegisteredGroup | null => {
  const all = getAllRegisteredGroups();
  return all[chatJid] ?? null;
};

/**
 * Build a production `ProviderInvoker` backed by `runContainerAgent`.
 *
 * Boot wiring (src/index.ts):
 *   ```ts
 *   import { setProviderInvoker } from './workflows/executor/provider-bridge.js';
 *   import { createNanoClawProviderInvoker } from './workflows/bridge/nanoclaw-provider-invoker.js';
 *   const store = new SqliteWorkflowStore(_getDb());
 *   setProviderInvoker(createNanoClawProviderInvoker({ store }));
 *   ```
 */
export function createNanoClawProviderInvoker(
  deps: NanoClawInvokerDeps,
): ProviderInvoker {
  const store = deps.store;
  const runContainer = deps.runContainer ?? runContainerAgent;
  const resolveGroup = deps.resolveGroup ?? defaultResolveGroup;

  return async function nanoclawInvoke(
    opts: ProviderInvocationOptions,
  ): Promise<ProviderInvocationResult> {
    const row = store.getRun(opts.workflowRunId);
    if (!row) {
      throw new Error(
        `nanoclaw-invoker: workflow run ${opts.workflowRunId} not found in store`,
      );
    }
    if (!row.chat_jid) {
      // Provider nodes require a routed group. Bash/script nodes don't need
      // this — they execute in-process. A run created without a chat_jid
      // cannot reach a NanoClaw container.
      throw new Error(
        `nanoclaw-invoker: workflow run ${opts.workflowRunId} has no chat_jid — cannot route to a group`,
      );
    }

    const group = resolveGroup(row.chat_jid);
    if (!group) {
      throw new Error(
        `nanoclaw-invoker: no registered group for chat_jid ${row.chat_jid}`,
      );
    }

    // Honour fresh_context on loop nodes — drop the prior sessionId so the
    // container spawns with a clean Claude / Bifrost session.
    const sessionId = opts.freshContext ? undefined : opts.sessionId;

    const input: ContainerInput = {
      prompt: opts.prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid: row.chat_jid,
      isMain: group.isMain ?? false,
      isScheduledTask: false,
      assistantName: opts.model,
      requestingUserId: row.user_id ?? undefined,
    };

    // Fail-fast on a pre-aborted signal so we never spawn a container just
    // to immediately kill it.
    if (opts.signal?.aborted) {
      throw new Error('nanoclaw-invoker: aborted before container spawn');
    }

    let containerProc: ChildProcess | null = null;
    let abortListener: (() => void) | null = null;

    if (opts.signal) {
      abortListener = () => {
        if (containerProc?.pid && !containerProc.killed) {
          try {
            containerProc.kill('SIGTERM');
            logger.info(
              {
                workflowRunId: opts.workflowRunId,
                nodeId: opts.nodeId,
                pid: containerProc.pid,
              },
              'nanoclaw-invoker.signal_forwarded',
            );
          } catch (err) {
            logger.warn(
              {
                err: err instanceof Error ? err.message : String(err),
                workflowRunId: opts.workflowRunId,
                nodeId: opts.nodeId,
              },
              'nanoclaw-invoker.signal_forward_failed',
            );
          }
        }
      };
      opts.signal.addEventListener('abort', abortListener);
    }

    try {
      const output: ContainerOutput = await runContainer(
        group,
        input,
        (proc) => {
          containerProc = proc;
          // Race: if the signal aborted between spawn and the (proc, name)
          // callback, fire SIGTERM immediately so we don't strand a container.
          if (opts.signal?.aborted) {
            try {
              proc.kill('SIGTERM');
            } catch {
              /* best-effort */
            }
          }
        },
      );

      if (output.status === 'error') {
        throw new Error(
          output.error ??
            'nanoclaw-invoker: container returned error status with no message',
        );
      }

      return {
        output: output.result ?? '',
        sessionId: output.newSessionId,
      };
    } finally {
      if (abortListener && opts.signal) {
        opts.signal.removeEventListener('abort', abortListener);
      }
    }
  };
}
