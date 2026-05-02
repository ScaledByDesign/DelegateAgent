// ─── Chat fast-path dispatch ───
//
// Mirrors openclaw's `src/auto-reply/dispatch.ts` entry point: returns a
// handled-or-not result so the channel can decide whether to escalate to
// the heavy container path. The actual openclaw dispatcher is much larger
// (hooks, plugins, command-targets, silent-reply policy, typing
// indicators, message-sending hooks); we keep just the decision + the
// reply call because Delegate's Channel API only needs to know
// "did I handle this myself, or do I need to escalate?".

import { chatComplete } from './bifrost-client.js';
import { classifyForFastPath } from './heuristic.js';
import type { ChatDispatchResult, ChatInbound } from './types.js';

// Marker the Delegate poll-handler emits when wrapping a user message with
// task context (see app/api/agent/channel/poll/poll-handler.ts ~L666). When
// present we extract just the post-marker portion as the actual user
// message and treat the preamble as additional system context.
const USER_MESSAGE_DELIMITER = '\n━━━━━━━━━━━━━━━━━━━━━━━━\nUSER MESSAGE:\n';

interface SplitContext {
  userText: string;
  systemPrefix: string | null;
}

function splitWrappedContext(text: string): SplitContext {
  const idx = text.indexOf(USER_MESSAGE_DELIMITER);
  if (idx === -1) {
    return { userText: text, systemPrefix: null };
  }
  return {
    userText: text.slice(idx + USER_MESSAGE_DELIMITER.length).trim(),
    systemPrefix: text.slice(0, idx).trim(),
  };
}

/** Optional callback for a richer system prompt (task title, description). */
export type ChatContextResolver = (
  jid: string,
) => Promise<{ system: string } | null> | { system: string } | null;

let contextResolver: ChatContextResolver | null = null;

/**
 * Plug in a function the dispatch will call to assemble a system prompt
 * (task title, description, recent message history, agent persona) for a
 * given JID. If no resolver is registered, falls back to a generic prompt.
 */
export function setChatContextResolver(fn: ChatContextResolver | null): void {
  contextResolver = fn;
}

const FALLBACK_SYSTEM_PROMPT = [
  'You are DelegateAgent, the conversational AI assistant for the Delegate workspace.',
  'Reply concisely and conversationally. Do not pretend to execute tools or modify',
  'files — if the user asks for work that needs file edits or commands, ask them to',
  'phrase it as a task and the heavier agent will pick it up.',
].join(' ');

/**
 * Try to handle an inbound message via the chat fast-path.
 *
 * - Returns `{ handled: true, replyText }` if Bifrost answered. The caller
 *   should send `replyText` back through the channel and skip the container.
 * - Returns `{ handled: false, reason }` if either the heuristic skipped
 *   the message or Bifrost errored. Caller falls through to the existing
 *   onMessage → container path.
 */
export async function dispatchChatFastPath(
  inbound: ChatInbound,
): Promise<ChatDispatchResult> {
  // The Delegate poll-handler wraps user messages on task JIDs with a large
  // task-context preamble. Strip it before classifying so a 22-char "hi" isn't
  // judged as a 1500-char prompt; preserve the preamble as the system context.
  const split = splitWrappedContext(inbound.text);
  const userText = split.userText;

  const skip = classifyForFastPath(userText);
  if (skip) {
    return { handled: false, reason: skip };
  }

  const startedAt = Date.now();
  let system = split.systemPrefix
    ? `${FALLBACK_SYSTEM_PROMPT}\n\n--- TASK CONTEXT ---\n${split.systemPrefix}`
    : FALLBACK_SYSTEM_PROMPT;
  if (contextResolver) {
    try {
      const ctx = await contextResolver(inbound.jid);
      if (ctx?.system) system = ctx.system;
    } catch {
      // Context resolver failed — log via console only, fall back to
      // generic system prompt rather than escalating.
      // (Channel-level Sentry capture will be added by the channel itself.)
    }
  }

  try {
    const reply = await chatComplete({
      system,
      userMessage: userText,
    });
    return {
      handled: true,
      replyText: reply.text,
      latencyMs: Date.now() - startedAt,
      model: reply.model,
    };
  } catch {
    return { handled: false, reason: 'bifrost-error' };
  }
}
