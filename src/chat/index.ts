// ─── DelegateAgent chat fast-path ───
//
// Bypasses the per-message Docker container for short conversational
// messages. Modeled after openclaw's `src/auto-reply/` dispatch surface
// (decision → reply → escalate-on-skip), trimmed to single-channel use.
//
// See `dispatch.ts` for the entry point used by `src/channels/delegate.ts`.

export { dispatchChatFastPath, setChatContextResolver } from "./dispatch.js";
export { classifyForFastPath } from "./heuristic.js";
export type {
  ChatBifrostRequest,
  ChatBifrostResponse,
} from "./bifrost-client.js";
export type {
  ChatDispatchResult,
  ChatInbound,
  ChatSkipReason,
} from "./types.js";
