/**
 * Container Runner for DelegateAgent
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  ONECLI_API_KEY,
  ONECLI_URL,
  TIMEZONE,
  getEnvWithFallback,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { OneCLI } from '@onecli-sh/sdk';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';
import {
  recordContainerStart,
  recordContainerEnd,
} from './web-ui/container-telemetry.js';
import {
  recordContainerSpawn,
  recordContainerExit,
  recordCredentialResolution,
  recordCredentialAttempt,
  jidKind,
} from './metrics.js';
import { redactInString, redactSecretEnvArgs } from './log-redact.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---DELEGATE_AGENT_OUTPUT_START---';
const OUTPUT_END_MARKER = '---DELEGATE_AGENT_OUTPUT_END---';

// Hephaestus Port 4 — separate marker pair for tool-call events
// (must match agent-runner). Forwarded to src/chat/event-emitter.ts.
const EVENT_START_MARKER = '---DELEGATE_AGENT_EVENT_START---';
const EVENT_END_MARKER = '---DELEGATE_AGENT_EVENT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  /**
   * Phase 5 (credential-mode-toggle plan): the Delegate user id that
   * dispatched this message. Plumbed from the inbound message envelope
   * (`NewMessage.requesting_user_id`, originating from the channel's
   * poll-response). Passed through to `buildContainerArgs` →
   * `resolveLLMKeysFromDelegate(workspaceId, requestingUserId)` so the
   * picker can prefer a per-user OAuth row over the workspace default.
   *
   * Undefined for non-Delegate channels (WhatsApp/Telegram/Slack/etc.) —
   * the picker correctly falls back to workspace-default credentials.
   */
  requestingUserId?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the OneCLI gateway, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main gets writable access to the store (SQLite DB) so it can
    // query and write to the database directly.
    const storeDir = path.join(projectRoot, 'store');
    mounts.push({
      hostPath: storeDir,
      containerPath: '/workspace/project/store',
      readonly: false,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Mount .gitconfig for safe.directory setting (enables git in worktrees owned by root)
  const gitconfigPath = path.join(groupSessionsDir, '.gitconfig');
  if (!fs.existsSync(gitconfigPath)) {
    fs.writeFileSync(gitconfigPath, '[safe]\n\tdirectory = *\n');
  }
  mounts.push({
    hostPath: gitconfigPath,
    containerPath: '/home/node/.gitconfig',
    readonly: true,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    const srcIndex = path.join(agentRunnerSrc, 'index.ts');
    const cachedIndex = path.join(groupAgentRunnerDir, 'index.ts');
    const needsCopy =
      !fs.existsSync(groupAgentRunnerDir) ||
      !fs.existsSync(cachedIndex) ||
      (fs.existsSync(srcIndex) &&
        fs.statSync(srcIndex).mtimeMs > fs.statSync(cachedIndex).mtimeMs);
    if (needsCopy) {
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

/**
 * Build the `docker run …` argv for an agent container.
 *
 * Phase 5 (credential-mode-toggle plan): the return type is now a result
 * object so callers can distinguish three outcomes:
 *
 *   - `credentialsResolved === true`  → spawn the container normally.
 *   - `oauthHardFail === true`        → OAuth mode was configured but the
 *     token is missing/invalid. Caller MUST short-circuit (no Bifrost
 *     fallback) and surface `oauth_token_missing` upstream.
 *   - `credentialsResolved === false` && !oauthHardFail → no creds resolved
 *     at any tier. Caller spawns with degraded behaviour (existing error
 *     path).
 *
 * The mode discriminator is propagated to `recordContainerSpawn` /
 * `recordContainerExit` via `resolvedMode` so the active-containers gauge
 * keeps a stable workspace_id+mode label across the spawn/exit pair.
 */
async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentIdentifier?: string,
  workspaceId?: string,
  requestingUserId?: string,
): Promise<{
  args: string[];
  oauthHardFail: boolean;
  credentialsResolved: boolean;
  resolvedMode: 'api_key' | 'oauth' | 'none';
}> {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Inject workspace context for per-workspace credential resolution
  if (workspaceId) {
    args.push('-e', `DELEGATE_WORKSPACE_ID=${workspaceId}`);
  }

  // ── Credential injection (multi-tenant) ────────────────────────────────
  // Strategy: resolve per-workspace keys from Delegate API FIRST.
  // Route through Bifrost as a proxy if available (baseURL only, not the key).
  // Fall back to OneCLI gateway or static env vars only when workspace keys fail.
  //
  // This ensures each workspace uses its OWN API keys and Bifrost VK,
  // not a shared global key from the .env file.

  const DELEGATE_URL = process.env.DELEGATE_URL || 'https://delegate.ws';
  // Canonical: DELEGATE_AGENT_TOKEN. Legacy fallback: DELEGATE_API_KEY.
  const DELEGATE_AGENT_TOKEN_ENV =
    getEnvWithFallback('DELEGATE_AGENT_TOKEN', ['DELEGATE_API_KEY']) || '';
  const BIFROST_URL = process.env.BIFROST_URL || 'http://localhost:4000';
  const containerBifrostUrl = BIFROST_URL.replace(
    'localhost',
    'host.docker.internal',
  ).replace('127.0.0.1', 'host.docker.internal');

  // Always inject Delegate API context so containers can resolve tokens at runtime
  args.push(
    '-e',
    `DELEGATE_URL=${DELEGATE_URL.replace('localhost', 'host.docker.internal')}`,
  );
  if (DELEGATE_AGENT_TOKEN_ENV) {
    // Inject all three names (same value) for skill-catalog compatibility:
    //   - DELEGATE_AGENT_TOKEN — canonical name (matches Delegate's env)
    //   - DELEGATE_API_KEY     — legacy alias used by older container skills
    //   - DELEGATE_API_TOKEN   — name used throughout .claude/skills/*/SKILL.md
    //                            and .claude/skills/CLAUDE.md ("Authorization:
    //                            Bearer $DELEGATE_API_TOKEN"). Without this
    //                            alias, every documented skill curl sent an
    //                            empty Bearer header → 401.
    // All three will collapse to DELEGATE_AGENT_TOKEN in a future release once
    // the skill catalog and runtime CLAUDE.md migrate to the canonical name.
    args.push('-e', `DELEGATE_AGENT_TOKEN=${DELEGATE_AGENT_TOKEN_ENV}`);
    args.push('-e', `DELEGATE_API_KEY=${DELEGATE_AGENT_TOKEN_ENV}`);
    args.push('-e', `DELEGATE_API_TOKEN=${DELEGATE_AGENT_TOKEN_ENV}`);
  }

  // Forgetful (memory MCP server, hosted on core droplet). Containers reach it
  // via https://forgetful.delegate.ws/mcp; bearer-gated by core-caddy. Resolves
  // ${FORGETFUL_BEARER} placeholder in .mcp.json's forgetful server entry.
  // Optional: if unset, the MCP client logs an auth failure but the agent keeps
  // running with no semantic memory.
  const FORGETFUL_BEARER_ENV = process.env.FORGETFUL_BEARER;
  if (FORGETFUL_BEARER_ENV) {
    args.push('-e', `FORGETFUL_BEARER=${FORGETFUL_BEARER_ENV}`);
  }

  // Phase 2: Mint a per-workspace JWT for this container. The platform's
  // dual-accept auth verifies JWT first; legacy bearer remains accepted as
  // a fallback during the migration window. On any failure, the container
  // silently falls back to the legacy bearer injected above.
  if (workspaceId) {
    try {
      const { mintAgentJWT } = await import('./jwt-mint.js');
      const minted = await mintAgentJWT({ workspaceId });
      if (minted) {
        args.push('-e', `DELEGATE_AGENT_JWT=${minted.jwt}`);
        logger.info(
          {
            containerName,
            workspaceId,
            jti: minted.jti,
            expiresAt: minted.expiresAt,
          },
          'Agent JWT minted for container',
        );
      }
    } catch (e) {
      logger.warn(
        { containerName, err: (e as Error).message },
        'Agent JWT mint failed — container will use legacy bearer',
      );
    }
  }

  let credentialsResolved = false;
  let resolvedTier: 'workspace' | 'onecli' | 'static' | 'none' = 'none';
  let resolvedMode: 'api_key' | 'oauth' | 'none' = 'none';
  // Phase 5 (credential-mode-toggle plan): when OAuth mode is configured but
  // the token is missing, we MUST NOT silently fall through to Bifrost. This
  // sentinel short-circuits Tier 2 (OneCLI) and Tier 3 (static Bifrost) so the
  // caller surfaces `oauth_token_missing` upstream instead.
  let oauthHardFail = false;

  // Tier 1: Per-workspace keys from Delegate API (preferred for multi-tenant SaaS)
  if (workspaceId) {
    try {
      const { resolveLLMKeysFromDelegate } =
        await import('./credential-client.js');
      const keys = await resolveLLMKeysFromDelegate(
        workspaceId,
        requestingUserId,
      );

      // Phase 5 branch A — OAuth picked AND token present.
      // Inject ONLY CLAUDE_CODE_OAUTH_TOKEN. Deliberately skip
      // ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL — OAuth speaks
      // api.anthropic.com directly without going through Bifrost.
      if (keys?.mode === 'oauth' && keys.oauthToken) {
        args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${keys.oauthToken}`);
        if (keys.openaiKey) {
          args.push('-e', `OPENAI_API_KEY=${keys.openaiKey}`);
        }
        credentialsResolved = true;
        resolvedTier =
          keys.pickedScope === 'personal' ? 'workspace' : 'workspace';
        // Note: `resolvedTier` enum (workspace|onecli|static|none) doesn't have
        // a 'user' value. The personal vs workspace distinction is captured by
        // `pickedScope` upstream and surfaced through logs / Sentry breadcrumbs.
        resolvedMode = 'oauth';
        recordCredentialAttempt('workspace', 'success');
        logger.info(
          {
            containerName,
            workspaceId,
            requestingUserId,
            mode: 'oauth',
            pickedScope: keys.pickedScope,
          },
          'OAuth credentials resolved',
        );
      }
      // Phase 5 branch B — OAuth picked but token missing → HARD FAIL.
      // Don't fall through to Bifrost. The caller short-circuits the spawn
      // and emits delegation_status: failed with reason=oauth_token_missing.
      else if (keys?.mode === 'oauth' && !keys.oauthToken) {
        oauthHardFail = true;
        recordCredentialAttempt('workspace', 'oauth_missing_token');
        logger.warn(
          { containerName, workspaceId, requestingUserId, mode: 'oauth' },
          'OAuth mode active but token missing — refusing to fall through to Bifrost',
        );
      }
      // Phase 5 branch C — api_key picked (existing Tier 1 happy path).
      else if (keys?.anthropicKey) {
        args.push('-e', `ANTHROPIC_API_KEY=${keys.anthropicKey}`);
        // Route through Bifrost proxy if available (for rate limiting + observability)
        // but use the workspace-specific key, not the global one
        if (keys.anthropicBaseUrl) {
          args.push('-e', `ANTHROPIC_BASE_URL=${keys.anthropicBaseUrl}`);
        } else {
          args.push(
            '-e',
            `ANTHROPIC_BASE_URL=${containerBifrostUrl}/anthropic`,
          );
        }
        credentialsResolved = true;
        resolvedTier = 'workspace';
        resolvedMode = 'api_key';
        recordCredentialAttempt('workspace', 'success');
        logger.info(
          {
            containerName,
            workspaceId,
            requestingUserId,
            mode: 'api_key',
            pickedScope: keys.pickedScope,
          },
          'LLM keys resolved from workspace integration',
        );
      } else {
        // Phase 5 branch D — keys null / unexpected shape. Fall through to
        // Tier 2/3 as before (back-compat with old Delegate deploys).
        recordCredentialAttempt('workspace', 'miss');
      }
      if (keys?.openaiKey && !credentialsResolved) {
        // OpenAI key alone is not enough to mark resolved, but inject it so
        // the agent's auxiliary openai-calling skills work.
        args.push('-e', `OPENAI_API_KEY=${keys.openaiKey}`);
      }
    } catch (e) {
      recordCredentialAttempt('workspace', 'error');
      logger.warn(
        { containerName, err: (e as Error).message },
        'Workspace LLM key resolution failed — falling back',
      );
    }
  }

  // Tier 2: OneCLI gateway (if installed). Skipped on oauthHardFail to
  // honour the AC-OAUTH-HARD-FAIL-NO-BIFROST guarantee.
  if (!credentialsResolved && !oauthHardFail) {
    const onecliApplied = await onecli.applyContainerConfig(args, {
      addHostMapping: false,
      agent: agentIdentifier,
    });
    if (onecliApplied) {
      credentialsResolved = true;
      resolvedTier = 'onecli';
      resolvedMode = 'api_key';
      recordCredentialAttempt('onecli', 'success');
      logger.info({ containerName }, 'OneCLI gateway config applied');
    } else {
      recordCredentialAttempt('onecli', 'unavailable');
    }
  } else {
    recordCredentialAttempt('onecli', 'skipped');
  }

  // Tier 3: Static .env keys through Bifrost (admin/dev fallback only).
  // Phase 5: skipped on oauthHardFail. This is the load-bearing guard that
  // enforces AC-OAUTH-HARD-FAIL-NO-BIFROST — even if ANTHROPIC_API_KEY is set
  // in the host env, we MUST NOT inject it when OAuth mode is configured but
  // the token is missing/expired.
  if (!credentialsResolved && !oauthHardFail) {
    const BIFROST_KEY = process.env.ANTHROPIC_API_KEY;
    if (BIFROST_KEY) {
      args.push('-e', `ANTHROPIC_API_KEY=${BIFROST_KEY}`);
      args.push('-e', `ANTHROPIC_BASE_URL=${containerBifrostUrl}/anthropic`);
      credentialsResolved = true;
      resolvedTier = 'static';
      resolvedMode = 'api_key';
      recordCredentialAttempt('static', 'success');
      logger.warn(
        { containerName },
        'Using static Bifrost key — no workspace-specific credentials resolved',
      );
    } else {
      recordCredentialAttempt('static', 'missing');
      logger.error(
        { containerName },
        'No credentials available — container will have no LLM access',
      );
    }
  } else {
    recordCredentialAttempt('static', 'skipped');
  }

  // Phase 5 post-tier error log distinguishes the two failure modes.
  if (!credentialsResolved) {
    if (oauthHardFail) {
      logger.error(
        { containerName, workspaceId, reason: 'oauth_token_missing' },
        'No Anthropic credentials resolved — OAuth hard-fail',
      );
    } else {
      logger.error(
        { containerName, workspaceId, reason: 'no_credentials' },
        'No Anthropic credentials resolved — generic failure',
      );
    }
  }

  // Winner-takes-all: one increment per buildContainerArgs call. Mode is
  // passed so dashboards can split resolution outcomes by api_key vs oauth.
  recordCredentialResolution(
    resolvedTier,
    oauthHardFail ? 'oauth' : resolvedMode,
  );

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return { args, oauthHardFail, credentialsResolved, resolvedMode };
}

/**
 * Hephaestus Port 4 — onEvent callback shape. The agent-runner emits one
 * event per Claude Agent SDK tool_use / tool_result / progress / thinking /
 * phase_marker block (see container/agent-runner/src/index.ts emitEventsFromSdkMessage).
 */
export interface AgentToolCallEvent {
  eventType: string;
  payload: unknown;
  agentMessageId?: string;
  durationMs?: number;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  onEvent?: (event: AgentToolCallEvent) => void,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Pre-flight: verify the container image exists before attempting spawn.
  // If the image is missing (first deploy before `container/build.sh` has run),
  // Docker exits with code 125/"No such image" and the spawn error propagates
  // as an unhandled rejection that can crash the main process. We catch it
  // gracefully here so the message is re-queued on the next poll cycle.
  try {
    // Use the statically-imported execSync so the child_process mock in tests
    // intercepts this call without needing `node:child_process` aliasing.
    execSync(`docker image inspect ${CONTAINER_IMAGE}`, { stdio: 'ignore' });
  } catch {
    logger.error(
      { image: CONTAINER_IMAGE },
      'Container image not found — run `bash container/build.sh` on the droplet. Message will be re-queued.',
    );
    return {
      status: 'error',
      result: null,
      error: `Container image '${CONTAINER_IMAGE}' not found. Run \`bash /opt/delegate-agent/container/build.sh\` on the droplet.`,
    };
  }

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `delegate-agent-${safeName}-${Date.now()}`;
  // Main group uses the default OneCLI agent; others use their own agent.
  const agentIdentifier = input.isMain
    ? undefined
    : group.folder.toLowerCase().replace(/_/g, '-');
  const buildResult = await buildContainerArgs(
    mounts,
    containerName,
    agentIdentifier,
    group.workspaceId,
    input.requestingUserId,
  );
  const containerArgs = buildResult.args;
  const containerMode = buildResult.resolvedMode;

  // Phase 5 (credential-mode-toggle plan): short-circuit before spawn when
  // OAuth mode was configured but the token is missing/expired. This
  // enforces AC-OAUTH-HARD-FAIL-NO-BIFROST — the container is NEVER spawned
  // with Bifrost-fallback credentials in this state. The orchestrator's
  // caller maps the `oauth_token_missing:` error prefix to a
  // `delegation_status: failed` event upstream so the task ticket displays
  // the cause (see notifyFailure in src/channels/delegate.ts).
  if (buildResult.oauthHardFail) {
    logger.error(
      {
        group: group.name,
        containerName,
        workspaceId: group.workspaceId,
        requestingUserId: input.requestingUserId,
      },
      'OAuth hard-fail — skipping container spawn',
    );
    return {
      status: 'error',
      result: null,
      error:
        'oauth_token_missing: OAuth mode active for this workspace but the configured token is missing or invalid. Have an admin rotate the token in workspace settings (or revert to api_key mode).',
    };
  }

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: redactSecretEnvArgs(containerArgs).join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Telemetry + metrics: record spawn before the process is created so the
  // ring buffer + Prometheus counter both see the start even if spawn fails.
  recordContainerStart(containerName, group.folder);
  // jidKind() expects the JID format (colon-separated), not the folder
  // name (which sanitizes colons to hyphens). Use input.chatJid.
  // Phase 5: pass workspaceId + mode so the active-containers gauge has
  // stable per-workspace + per-mode labels across spawn/exit.
  recordContainerSpawn(
    jidKind(input.chatJid),
    input.isMain,
    group.workspaceId ?? 'unknown',
    containerMode === 'none' ? 'api_key' : containerMode,
  );

  // Single point that flushes BOTH telemetry sources on every terminal branch.
  // Status enum aligned with web-ui/container-telemetry.ts:
  // 'success' | 'error' | 'timeout'.
  const finalize = (
    status: 'success' | 'error' | 'timeout',
    exitCode: number | null,
    errorMessage?: string,
  ): void => {
    const durationSeconds = (Date.now() - startTime) / 1000;
    recordContainerEnd(
      containerName,
      status,
      exitCode ?? undefined,
      errorMessage,
    );
    // Phase 5: workspace + mode labels must match the spawn call exactly so
    // prom-client's gauge decrement targets the same series.
    recordContainerExit(
      jidKind(input.chatJid),
      status,
      durationSeconds,
      group.workspaceId ?? 'unknown',
      containerMode === 'none' ? 'api_key' : containerMode,
    );
  };

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for OUTPUT and EVENT markers (interleaved). EVENT
      // markers (Hephaestus Port 4) carry per-message tool-call events that
      // are forwarded to the chat event-emitter for batched POSTs to Delegate.
      if (onOutput || onEvent) {
        parseBuffer += chunk;
        // Scan-and-consume loop. Each iteration: find the earliest marker
        // start in the buffer; if its end marker isn't present, stop and wait
        // for more data. Otherwise extract the JSON, slice the buffer, and
        // dispatch.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const outStart = parseBuffer.indexOf(OUTPUT_START_MARKER);
          const evStart = parseBuffer.indexOf(EVENT_START_MARKER);
          let startIdx: number;
          let isEvent: boolean;
          if (outStart === -1 && evStart === -1) break;
          if (outStart === -1) {
            startIdx = evStart;
            isEvent = true;
          } else if (evStart === -1) {
            startIdx = outStart;
            isEvent = false;
          } else {
            isEvent = evStart < outStart;
            startIdx = isEvent ? evStart : outStart;
          }

          const startMarker = isEvent
            ? EVENT_START_MARKER
            : OUTPUT_START_MARKER;
          const endMarker = isEvent ? EVENT_END_MARKER : OUTPUT_END_MARKER;
          const endIdx = parseBuffer.indexOf(endMarker, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + startMarker.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + endMarker.length);

          if (isEvent) {
            // EVENT marker — forward to onEvent. Failures in onEvent must NEVER
            // affect the agent run; we only log + drop.
            if (onEvent) {
              try {
                const parsed = JSON.parse(jsonStr);
                onEvent(parsed);
              } catch (err) {
                logger.warn(
                  { group: group.name, error: err },
                  'Failed to parse streamed event chunk',
                );
              }
            }
          } else {
            try {
              const parsed: ContainerOutput = JSON.parse(jsonStr);
              if (parsed.newSessionId) {
                newSessionId = parsed.newSessionId;
              }
              hadStreamingOutput = true;
              // Activity detected — reset the hard timeout
              resetTimeout();
              // Call onOutput for all markers (including null results)
              // so idle timers start even for "silent" query completions.
              if (onOutput) {
                outputChain = outputChain.then(() => onOutput(parsed));
              }
            } catch (err) {
              logger.warn(
                { group: group.name, error: err },
                'Failed to parse streamed output chunk',
              );
            }
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      try {
        stopContainer(containerName);
      } catch (err) {
        logger.warn(
          { group: group.name, containerName, err },
          'Graceful stop failed, force killing',
        );
        container.kill('SIGKILL');
      }
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          finalize('success', code);
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        finalize(
          'timeout',
          code,
          `Container timed out after ${configTimeout}ms`,
        );
        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        // On error, log input metadata only — not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Container Args ===`,
          redactInString(containerArgs.join(' ')),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        finalize('error', code, `Container exited with code ${code}`);
        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        finalize('success', code);
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        finalize(output.status === 'success' ? 'success' : 'error', code);
        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        finalize(
          'error',
          code,
          err instanceof Error ? err.message : String(err),
        );
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      finalize('error', null, err.message);
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    script?: string | null;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
