// ─── Chat fast-path heuristic ───
//
// Decides whether an inbound message should be handled by the lightweight
// chat path (direct Bifrost call, no container) or escalated to the heavy
// container path (Claude Code SDK with tools).
//
// Mirrors openclaw's `src/auto-reply/command-detection.ts` decision style:
// fast checks first, conservative fallback. Anything we can't classify
// confidently → escalate (container always works, fast-path is opportunistic).

import type { ChatSkipReason } from "./types.js";

/** Soft cap on what we consider "conversational length". */
const CHAT_MAX_CHARS = parseInt(
  process.env.CHAT_FAST_PATH_MAX_CHARS || "400",
  10,
);

/**
 * Words that strongly imply the user wants the agent to DO work
 * (file edits, command execution, web fetches, etc.). When any of these
 * appear, fall through to the container path so the agent has tools.
 *
 * The list is intentionally conservative — we'd rather over-escalate
 * (chat rendered slowly through container) than under-escalate
 * (real work answered with a fluff reply).
 */
const TASK_INTENT_TOKENS = [
  "write", "create", "build", "implement", "scaffold", "add",
  "fix", "debug", "refactor", "rewrite", "patch", "edit", "modify",
  "update", "delete", "remove",
  "run", "execute", "deploy", "ship", "release", "publish",
  "test", "verify", "check", "audit", "review",
  "search", "find", "grep", "look up", "research",
  "open", "read", "show me", "list",
  "commit", "push", "merge", "branch", "rebase",
  "install", "configure", "setup", "set up",
  "generate", "produce", "compile",
];

const SLASH_COMMAND_PATTERN = /^\s*\//;

/**
 * Returns null if the message is fast-path eligible, or a skip reason
 * otherwise. Caller should fall through to the container path on a skip.
 */
export function classifyForFastPath(text: string): ChatSkipReason | null {
  if (process.env.CHAT_FAST_PATH === "0") {
    return "fast-path-disabled";
  }

  const trimmed = text.trim();

  if (SLASH_COMMAND_PATTERN.test(trimmed)) {
    return "command-detected";
  }

  if (trimmed.length > CHAT_MAX_CHARS) {
    return "too-long";
  }

  // Lowercase once, then check tokens with word boundaries to avoid false
  // positives on "i don't write code today" → matches "write".
  const lower = trimmed.toLowerCase();
  for (const token of TASK_INTENT_TOKENS) {
    // Match as whole word, not as substring of a longer word.
    const re = new RegExp(`(?:^|\\W)${token.replace(/\s+/g, "\\s+")}(?:\\W|$)`, "i");
    if (re.test(lower)) {
      return "task-intent-detected";
    }
  }

  return null;
}
