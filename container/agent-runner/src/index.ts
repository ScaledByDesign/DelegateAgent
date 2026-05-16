/**
 * DelegateAgent Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import {
  query,
  HookCallback,
  PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import { isRetryableStreamError, withRetryableStream } from './retry-stream.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  /**
   * The Delegate `TaskDelegation.id` this container is processing.
   * Previously used by the in-container heartbeat poster (removed Phase 4 of
   * agent-system-consolidation). Retained in ContainerInput for back-compat
   * with host builds that still include it; heartbeat is now a poll side-effect
   * via the host channel's x-delegation-id header.
   */
  delegationId?: string;
}

// ─── Heartbeat (Phase 4 agent-system-consolidation) ──────────────────────────
// The dedicated heartbeat poster has been removed. Heartbeat writes are now a
// side-effect of every authenticated poll in the platform's poll-handler.ts —
// the host-side channel (src/channels/delegate.ts) includes x-delegation-id on
// poll requests, and the poll route bumps lastHeartbeatAt on every auth success.
//
// Checkpoint writes (combined heartbeat+checkpoint POSTs) still reach
// /api/agent/heartbeat — that endpoint is deprecated but preserved for
// back-compat (D11). Container code that posts checkpoints should continue
// using that path until the full migration is complete.

process.on('SIGTERM', () => {
  process.exit(0);
});
process.on('SIGINT', () => {
  process.exit(0);
});

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

// ─── Stage Handoff (Phase 5 agent-system-consolidation) ─────────────────────
// When the host dispatches a next-stage delegation to a still-alive container,
// the AgentMessage content is prefixed with a magic header carrying the new
// stage's metadata. Wire format MUST match
// `lib/delegation/dispatch-to-droplet.ts:formatStageHandoffHeader`.
//
// On detection we end the current SDK session (the outer loop will clear
// sessionId and start fresh) so BMAD stages stay context-isolated per Critic
// iter-1 §13.IV — DEV must not see QA verdicts; REVIEW must not see DEV's
// internal monologue. Container process + filesystem isolation persists; only
// the SDK session resets.
const STAGE_HANDOFF_HEADER_START = '__DELEGATE_STAGE_HANDOFF__';
const STAGE_HANDOFF_HEADER_END = '__END__';

interface StageHandoffEnvelope {
  newStage: string;
  newDelegationId: string;
  freshSessionId: true;
}

/** Returns { envelope, cleanedPrompt } when the magic header is present at
 *  the start of `text`, or null otherwise. Defensive: malformed JSON between
 *  the markers is treated as "no handoff" so a fluky prefix can't crash us. */
export function parseStageHandoffHeader(
  text: string,
): { envelope: StageHandoffEnvelope; cleanedPrompt: string } | null {
  if (!text.startsWith(STAGE_HANDOFF_HEADER_START)) return null;
  const startLen = STAGE_HANDOFF_HEADER_START.length;
  const endIdx = text.indexOf(STAGE_HANDOFF_HEADER_END, startLen);
  if (endIdx === -1) return null;
  const jsonStr = text.slice(startLen, endIdx);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { newStage?: unknown }).newStage !== 'string' ||
    typeof (parsed as { newDelegationId?: unknown }).newDelegationId !== 'string' ||
    (parsed as { freshSessionId?: unknown }).freshSessionId !== true
  ) {
    return null;
  }
  // Strip header + optional trailing newlines that dispatch adds after END.
  const afterEnd = endIdx + STAGE_HANDOFF_HEADER_END.length;
  const cleanedPrompt = text.slice(afterEnd).replace(/^\r?\n\r?\n?/, '');
  return { envelope: parsed as StageHandoffEnvelope, cleanedPrompt };
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// Must match src/container-runner.ts on the host side — protocol contract
// for extracting agent output from the container's stdout stream.
const OUTPUT_START_MARKER = '---DELEGATE_AGENT_OUTPUT_START---';
const OUTPUT_END_MARKER = '---DELEGATE_AGENT_OUTPUT_END---';

// Hephaestus Port 4 — separate marker pair for tool-call events.
// Host-side parser (src/container-runner.ts) recognizes these and forwards
// to the chat event-emitter, which batches + POSTs to Delegate.
const EVENT_START_MARKER = '---DELEGATE_AGENT_EVENT_START---';
const EVENT_END_MARKER = '---DELEGATE_AGENT_EVENT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

/** Hephaestus Port 4 — write a single tool-call event to stdout for the host to forward. */
function writeEvent(event: {
  eventType: string;
  payload: unknown;
  agentMessageId?: string;
  durationMs?: number;
}): void {
  console.log(EVENT_START_MARKER);
  console.log(JSON.stringify(event));
  console.log(EVENT_END_MARKER);
}

/**
 * Hephaestus Port 4 — extract tool-call events from a Claude Agent SDK
 * message and emit one writeEvent() per relevant content block.
 *
 * SDK message shapes we care about:
 *   - assistant: BetaMessage.content[] with tool_use / thinking blocks
 *   - user: MessageParam.content[] may contain tool_result blocks (replays)
 *   - tool_progress: top-level message → progress event
 *   - tool_use_summary: top-level → phase_marker (we treat summaries as
 *     phase markers since the SDK uses them to demarcate sub-task batches)
 *
 * We stay defensive — the SDK shapes evolve, so we type-guard every field.
 */
function emitEventsFromSdkMessage(
  message: unknown,
  agentMessageId: string | undefined,
): void {
  if (!message || typeof message !== 'object') return;
  const msg = message as Record<string, unknown>;
  const type = typeof msg.type === 'string' ? msg.type : '';

  if (type === 'assistant') {
    const inner = (msg.message ?? {}) as Record<string, unknown>;
    const blocks = Array.isArray(inner.content) ? (inner.content as unknown[]) : [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      const btype = typeof b.type === 'string' ? b.type : '';
      if (btype === 'tool_use') {
        writeEvent({
          eventType: 'tool_use',
          agentMessageId,
          payload: {
            tool: b.name,
            tool_use_id: b.id,
            args: b.input,
          },
        });
      } else if (btype === 'thinking') {
        writeEvent({
          eventType: 'thinking',
          agentMessageId,
          payload: { text: b.thinking ?? b.text },
        });
      }
    }
    return;
  }

  if (type === 'user') {
    const inner = (msg.message ?? {}) as Record<string, unknown>;
    const blocks = Array.isArray(inner.content) ? (inner.content as unknown[]) : [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_result') {
        writeEvent({
          eventType: 'tool_result',
          agentMessageId,
          payload: {
            tool_use_id: b.tool_use_id,
            output: b.content,
            is_error: b.is_error === true,
          },
        });
      }
    }
    return;
  }

  if (type === 'tool_progress') {
    writeEvent({
      eventType: 'progress',
      agentMessageId,
      durationMs:
        typeof msg.elapsed_time_seconds === 'number'
          ? Math.round(msg.elapsed_time_seconds * 1000)
          : undefined,
      payload: {
        tool: msg.tool_name,
        tool_use_id: msg.tool_use_id,
        elapsed_seconds: msg.elapsed_time_seconds,
      },
    });
    return;
  }

  if (type === 'tool_use_summary') {
    writeEvent({
      eventType: 'phase_marker',
      agentMessageId,
      payload: {
        summary: msg.summary,
        preceding_tool_use_ids: msg.preceding_tool_use_ids,
      },
    });
    return;
  }
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(
      `Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(
        messages,
        summary,
        assistantName,
      );
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(
        `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {}
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 *
 * Phase 5: when any drained message carries the stage-handoff magic header,
 * the cleaned prompt is returned alone (later same-batch messages are
 * appended after the cleaned prompt). The caller is responsible for noticing
 * the handoff via `parseStageHandoffHeader`; we do NOT consume the header
 * here so the outer loop's session-reset logic stays in one place.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
  /** Phase 5 — set when an in-flight IPC message carried the stage-handoff
   *  magic header. The outer loop clears sessionId and re-enters runQuery
   *  with this prompt so the SDK starts a brand-new session. */
  stageHandoffPrompt?: string;
}> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  let stageHandoffPrompt: string | undefined;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      // Phase 5 — stage handoff. End the current SDK session so the outer
      // loop re-enters with a fresh sessionId; queue any messages collected
      // BEFORE the handoff (rare but possible) as the handoff prompt's prefix.
      const handoff = parseStageHandoffHeader(text);
      if (handoff) {
        log(
          `Stage-handoff received: newStage=${handoff.envelope.newStage} ` +
            `newDelegationId=${handoff.envelope.newDelegationId} — ending session`,
        );
        stageHandoffPrompt = handoff.cleanedPrompt;
        stream.end();
        ipcPolling = false;
        return;
      }
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  // Wrap the SDK iterator with a single-retry guard for transient stream
  // errors (e.g. "Content block not found" from Bifrost SSE drops, ECONNRESET).
  // On retry, isFreshSession=true — caller clears resumeSessionAt so the SDK
  // starts from a clean parser state instead of resuming mid-conversation.
  await withRetryableStream({
    makeIterable: (isFreshSession) => {
      const effectiveResumeAt = isFreshSession ? undefined : resumeAt;
      if (isFreshSession) {
        log(
          `[stream-retry] Starting fresh session (cleared resumeSessionAt)`,
        );
        resumeAt = undefined;
      }
      return query({
        prompt: stream,
        options: {
          // Claude Code native binary is installed globally by the Dockerfile
          // (`npm install -g @anthropic-ai/claude-code`). The SDK's auto-resolver
          // looks for a platform-specific path (`.../claude-agent-sdk-linux-x64-musl/claude`)
          // which doesn't exist on glibc-based node:22-slim. Point at the global bin.
          pathToClaudeCodeExecutable:
            process.env.CLAUDE_CODE_EXECUTABLE_PATH || '/usr/local/bin/claude',
          // User-selectable model via env, threaded from Delegate dispatcher.
          // Read order (Delegate side picks):
          //   1. AgentProfile.delegateAgentModel (per-agent override)
          //   2. WorkspaceSettings.agentModel (workspace default — future)
          //   3. dispatcher fallback (claude-sonnet-4-5 — broad OAuth support)
          // When unset, SDK uses the CLI's built-in default (claude-sonnet-4-6),
          // which fails when the picked OAuth token doesn't grant access to it
          // (the silent "status:success, result:'model may not exist'" trap).
          ...(process.env.CLAUDE_AGENT_MODEL
            ? { model: process.env.CLAUDE_AGENT_MODEL }
            : {}),
          cwd: '/workspace/group',
          additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
          resume: sessionId,
          resumeSessionAt: effectiveResumeAt,
          systemPrompt: globalClaudeMd
            ? {
                type: 'preset' as const,
                preset: 'claude_code' as const,
                append: globalClaudeMd,
              }
            : undefined,
          allowedTools: [
            'Bash',
            'Read',
            'Write',
            'Edit',
            'Glob',
            'Grep',
            'WebSearch',
            'WebFetch',
            'Task',
            'TaskOutput',
            'TaskStop',
            'TeamCreate',
            'TeamDelete',
            'SendMessage',
            'TodoWrite',
            'ToolSearch',
            'Skill',
            'NotebookEdit',
            'mcp__delegateagent__*',
          ],
          env: sdkEnv,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          settingSources: ['project', 'user'],
          mcpServers: {
            // MCP server wire name is `delegateagent` (single word, no hyphen
            // so it's a valid JS identifier + a clean `mcp__delegateagent__*`
            // tool namespace). Tool allowlist above + MCP binary env-key
            // readers below stay in sync.
            delegateagent: {
              command: 'node',
              args: [mcpServerPath],
              env: {
                DELEGATEAGENT_CHAT_JID: containerInput.chatJid,
                DELEGATEAGENT_GROUP_FOLDER: containerInput.groupFolder,
                DELEGATEAGENT_IS_MAIN: containerInput.isMain ? '1' : '0',
              },
            },
          },
          hooks: {
            PreCompact: [
              { hooks: [createPreCompactHook(containerInput.assistantName)] },
            ],
          },
        },
      });
    },
    onRetry: (attempt, err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log(
        `[stream-retry] Retryable stream error (attempt ${attempt}): ${msg}`,
      );
      log(
        `[stream-retry] Retrying with fresh session after ${attempt}s backoff`,
      );
    },
    onMessage: async (message) => {
      messageCount++;
      const msgType =
        message.type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : message.type;
      log(`[msg #${messageCount}] type=${msgType}`);

      if (message.type === 'assistant' && 'uuid' in message) {
        lastAssistantUuid = (message as { uuid: string }).uuid;
      }

      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        log(`Session initialized: ${newSessionId}`);
      }

      // Hephaestus Port 4 — emit tool-call events to stdout. Host forwards
      // to Delegate via the chat event-emitter; we never call out from the
      // container directly (sandboxed, no API access).
      try {
        emitEventsFromSdkMessage(message, lastAssistantUuid);
      } catch (err) {
        log(`event-emit error: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (
        message.type === 'system' &&
        (message as { subtype?: string }).subtype === 'task_notification'
      ) {
        const tn = message as {
          task_id: string;
          status: string;
          summary: string;
        };
        log(
          `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
        );
      }

      if (message.type === 'result') {
        resultCount++;
        const textResult =
          'result' in message
            ? (message as { result?: string }).result
            : null;
        log(
          `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
        );
        // SDK result subtypes: 'success' (happy path) OR one of
        //   'error_during_execution' | 'error_max_turns' |
        //   'error_max_budget_usd' | 'error_max_structured_output_retries'
        const isErrorSubtype =
          typeof message.subtype === 'string' &&
          message.subtype !== 'success';
        // The SDK ALSO returns subtype='success' when an upstream API
        // call failed but the SDK gracefully recovered by emitting the
        // error text as the assistant's response (e.g. Bifrost VK
        // denied, Anthropic returned 4XX/5XX, missing token). The
        // assistant text body literally contains the API error
        // message. Treat these as terminal errors so the Delegate
        // state machine doesn't transition to `completed` for a
        // non-functional run.
        const looksLikeApiError =
          typeof textResult === 'string' &&
          (/^Failed to authenticate\.?\s/i.test(textResult) ||
            /API Error:\s*(401|403|404|429|5\d\d)/i.test(textResult) ||
            /usage[_ ]limit[_ ]exceeded/i.test(textResult) ||
            /Provider '[^']+' is not allowed/i.test(textResult));
        const isError = isErrorSubtype || looksLikeApiError;
        if (looksLikeApiError) {
          log(
            `Result text matches API-error pattern — emitting status='error' (subtype=${message.subtype})`,
          );
        }
        writeOutput({
          status: isError ? 'error' : 'success',
          result: textResult || null,
          newSessionId,
        });
      }
    },
  });

  ipcPolling = false;
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}, stageHandoff: ${stageHandoffPrompt ? 'yes' : 'no'}`,
  );
  return { newSessionId, lastAssistantUuid, closedDuringQuery, stageHandoffPrompt };
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (stderr) {
          log(`Script stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log(`Script error: ${error.message}`);
          return resolve(null);
        }

        // Parse last non-empty line of stdout as JSON
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log('Script produced no output');
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log(
              `Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`,
            );
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '165000',
  };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Script phase: run script before waking agent
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult
        ? 'wakeAgent=false'
        : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({
        status: 'success',
        result: null,
      });
      return;
    }

    // Script says wake agent — enrich prompt with script data
    log(`Script wakeAgent=true, enriching prompt with data`);
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(
        `Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`,
      );

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerPath,
        containerInput,
        sdkEnv,
        resumeAt,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // Phase 5 — stage handoff. The current SDK session was ended cleanly
      // because an in-flight IPC message carried the stage-handoff header.
      // Clear sessionId + resumeAt so the next runQuery starts a brand-new
      // Claude SDK session (BMAD context isolation), and feed in the cleaned
      // prompt (already stripped of the magic header by parseStageHandoffHeader).
      if (queryResult.stageHandoffPrompt) {
        log('Stage-handoff: minting fresh SDK session for next stage');
        sessionId = undefined;
        resumeAt = undefined;
        prompt = queryResult.stageHandoffPrompt;
        continue;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      // Phase 5 — stage handoff arriving while idle. Same session-reset
      // logic as the mid-query path above. The header may be the entire
      // text (single message) or the prefix when multiple messages were
      // drained together (join order preserves dispatch order).
      const idleHandoff = parseStageHandoffHeader(nextMessage);
      if (idleHandoff) {
        log(
          `Stage-handoff (idle): newStage=${idleHandoff.envelope.newStage} ` +
            `newDelegationId=${idleHandoff.envelope.newDelegationId} — fresh SDK session`,
        );
        sessionId = undefined;
        resumeAt = undefined;
        prompt = idleHandoff.cleanedPrompt;
        continue;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);

    // ── In-container cooldown hook (2026-05-16) ──────────────────────────
    // When the SDK throws because Anthropic returned 402 (credit_exhausted)
    // or 401 (auth_invalid) for the credential the picker just handed us,
    // report it back to Delegate so the picker excludes this row on the
    // next dispatch. Env vars are injected at container spawn by
    // container-runner.ts:498-499. Without this, the same dead credential
    // gets re-served on every retry — observed on smoke task
    // cmndofiid00017 (2026-05-16): 5× credit_exhausted in 12 min on the
    // same personal key.
    //
    // We classify here (not in the SDK error) because the SDK error text
    // is what surfaces all the way back to the user via the channel reply,
    // and we want to report cooldown BEFORE that propagates so the next
    // dispatch (often within seconds) picks the next-tier credential.
    //
    // Fire-and-forget with a 3s timeout — cooldown report failure must
    // NOT block the agent's own failure surfacing. The Delegate-side
    // reply-text classifier is the redundant backstop (lib/delegation/
    // settle-from-reply-text.ts emits cooldown when it matches the same
    // patterns), so a missed in-container report still gets caught.
    try {
      const lower = errorMessage.toLowerCase();
      const isCreditExhausted =
        lower.includes('credit balance') ||
        lower.includes('credit_balance') ||
        lower.includes('insufficient credits') ||
        lower.includes('quota exceeded') ||
        /\b402\b/.test(lower);
      const isAuthInvalid =
        lower.includes('invalid x-api-key') ||
        lower.includes('invalid api key') ||
        lower.includes('authentication_error') ||
        /\b401\b/.test(lower);

      const providerId = process.env.DELEGATE_LLM_PROVIDER_ID;
      const workspaceId = process.env.DELEGATE_LLM_WORKSPACE_ID;
      const delegateUrl = process.env.DELEGATE_URL || 'https://delegate.ws';
      const delegateToken =
        process.env.DELEGATE_AGENT_TOKEN || process.env.DELEGATE_API_KEY;

      if (
        (isCreditExhausted || isAuthInvalid) &&
        providerId &&
        workspaceId &&
        delegateToken
      ) {
        const reason = isCreditExhausted ? 'usage_limit_exceeded' : 'auth_error';
        log(
          `Reporting cooldown to Delegate (providerId=${providerId}, reason=${reason})`,
        );
        const ctrl = new AbortController();
        const timeoutId = setTimeout(() => ctrl.abort(), 3000);
        try {
          const res = await fetch(
            `${delegateUrl.replace(/\/$/, '')}/api/agent/integrations/llm-keys/cooldown`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                Authorization: `Bearer ${delegateToken}`,
              },
              body: JSON.stringify({
                providerId,
                workspaceId,
                reason,
                anthropicErrorCode: isCreditExhausted ? '402' : '401',
              }),
              signal: ctrl.signal,
            },
          );
          if (!res.ok) {
            log(
              `Cooldown report failed: status=${res.status} (non-fatal, will still exit)`,
            );
          } else {
            log(`Cooldown report acked (${res.status})`);
          }
        } finally {
          clearTimeout(timeoutId);
        }
      }
    } catch (reportErr) {
      // Non-fatal — Delegate's reply-text classifier is the redundant
      // backstop. Just log and continue to the exit path.
      log(
        `Cooldown report threw (non-fatal): ${reportErr instanceof Error ? reportErr.message : String(reportErr)}`,
      );
    }

    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
