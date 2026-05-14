// ─── Chat fast-path types ───
//
// Mirrors openclaw's `src/auto-reply/types.ts` shape but trimmed to what the
// Delegate channel actually uses. The rest of openclaw's auto-reply system
// (commands-registry, hooks, dispatch-dispatcher, etc.) is overkill for our
// single-channel use; we keep just the dispatch decision + reply payload.

export interface ChatInbound {
  /** Channel-scoped conversation id (e.g. "delegate:task:cmoo..."). */
  jid: string;
  /** Plain-text content of the inbound message. */
  text: string;
  /** Display-name of the sender (best-effort, used for system-prompt context). */
  senderName?: string;
  /**
   * Phase 0 of agent-path-credential-failover plan: emitted by platform
   * `poll-handler.ts` for all 4 JID branches. When present, used as the
   * primary workspaceId for chat fast-path credential resolution. When
   * absent (legacy platform deploys), dispatch falls back to deriving via
   * `/api/agent/context/[taskId]` for task JIDs only.
   */
  workspaceId?: string | null;
  /**
   * Phase 0/Phase 1 of agent-path-credential-failover plan: the requesting
   * Delegate user id (same source as PollMessage.requestingUserId). Threaded
   * into the credential resolver so per-user-override scopes can pick a
   * personal LLMProvider row when present.
   */
  requestingUserId?: string;
}

export type ChatDispatchResult =
  | { handled: true; replyText: string; latencyMs: number; model: string }
  | { handled: false; reason: ChatSkipReason; userMessage?: string };

export type ChatSkipReason =
  | 'command-detected' // starts with `/` or matches a slash-command pattern
  | 'task-intent-detected' // looks like a coding/work request, escalate to container
  | 'too-long' // longer than CHAT_MAX_CHARS — likely a real prompt
  | 'fast-path-disabled' // env flag CHAT_FAST_PATH=0
  | 'bifrost-error' // call to Bifrost failed; fall through to container path
  | 'credentials-failure' // workspace credentials exhausted/invalid — surface user message, DO NOT fall through
  | 'oauth-mode-container-only'; // workspace uses OAuth mode — defer to container path
