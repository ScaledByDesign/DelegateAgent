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
import { reportLLMCooldown } from './cooldown-client.js';
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
  /**
   * Phase 4 of `.omc/plans/stuck-delegation-spawn-failure.md` ("Bug D"): the
   * in-flight `TaskDelegation.id` the container is processing, when known.
   * The container's `agent-runner` reads this on startup and POSTs
   * /api/agent/heartbeat every 60s so the Delegate UI's status pill can
   * flip from OFFLINE → LIVE. Undefined for non-delegation traffic (chat,
   * scheduled tasks, workflow phases without a delegation row) — the
   * heartbeat poster simply no-ops in that case.
   *
   * The container protocol is JSON-over-stdin: adding a field is forward-
   * compatible (older containers ignore unknown fields).
   */
  delegationId?: string;
  /**
   * Phase 2.5b' — workflow run artifacts root (host path). When set,
   * `buildVolumeMounts` adds a writable mount at `/workspace/artifacts`
   * and `buildContainerArgs` injects `WORKFLOW_ARTIFACTS_DIR=/workspace/artifacts`
   * so the agent can write files (PDFs, generated text, etc.) into the
   * workflow's per-run artifacts directory. Channel-driven invocations
   * leave this undefined and the mount is omitted (existing behavior).
   */
  artifactsDir?: string;
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

async function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  /**
   * Workflow run artifacts root (host path). When provided, mounted writable
   * at `/workspace/artifacts` so the agent can produce files that survive
   * container teardown. Workflow YAMLs reference the path via the
   * `WORKFLOW_ARTIFACTS_DIR` env injected by `buildContainerArgs`.
   * Undefined for all channel-driven invocations.
   */
  artifactsDir?: string,
): Promise<VolumeMount[]> {
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

  // Sync workspace-authored skills (Delegate "Skills Marketplace") into the SAME
  // .claude/skills/ dir, so the agent can `cat`/load them exactly like the baked-in
  // skills above. Resolves BOTH workspace-global skills AND skills assigned to this
  // group's step/stage agent (group.agentProfileId, threaded through group
  // registration). Best-effort: a fetch failure never blocks the spawn; skills are
  // also delivered inline in the dispatch prompt. See memory
  // agent_skill_dual_system_2026_05_25 + agent_skill_dispatch_path_coverage_2026_05_25.
  if (group.workspaceId) {
    try {
      const { fetchSkillsFromDelegate } = await import('./skills-client.js');
      const dbSkills = await fetchSkillsFromDelegate(
        group.workspaceId,
        group.agentProfileId,
      );
      for (const skill of dbSkills) {
        // Sanitize key to a safe dir name; skip anything that escapes.
        const safeKey = skill.key.replace(/[^a-zA-Z0-9._-]/g, '-');
        if (!safeKey || safeKey.startsWith('.')) continue;
        const dstDir = path.join(skillsDst, safeKey);
        fs.mkdirSync(dstDir, { recursive: true });
        fs.writeFileSync(path.join(dstDir, 'SKILL.md'), skill.markdown);
      }
      if (dbSkills.length > 0) {
        logger.info(
          { folder: group.folder, count: dbSkills.length },
          'Workspace DB skills written to .claude/skills/',
        );
      }
    } catch (err) {
      logger.warn(
        { folder: group.folder, error: (err as Error).message },
        'Workspace DB skill sync failed (non-fatal; skills still delivered inline)',
      );
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

  // Phase 2.5b' — workflow artifacts mount. Writable, only when the caller
  // (workflow executor via nanoclaw-provider-invoker) provides an
  // artifactsDir. Files written to /workspace/artifacts persist to the
  // host's workflow run dir so they outlive the container.
  if (artifactsDir) {
    // Create the host dir defensively — workflow-runs-service is meant to
    // already have done this, but a missing dir is a confusing failure mode.
    fs.mkdirSync(artifactsDir, { recursive: true });
    mounts.push({
      hostPath: artifactsDir,
      containerPath: '/workspace/artifacts',
      readonly: false,
    });
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
  /**
   * When set, exposes `WORKFLOW_ARTIFACTS_DIR=<containerPath>` to the
   * container so workflow-aware prompts/skills know where to write files.
   * The companion writable mount is added by `buildVolumeMounts(artifactsDir)`.
   */
  workflowArtifactsContainerPath?: string,
  /**
   * In-flight `TaskDelegation.id` the container is processing. When set,
   * exposed as `DELEGATE_DELEGATION_ID` so the agent-runner's heartbeat
   * poster can include it in POST `/api/agent/heartbeat` calls every 60s.
   * Without this the Delegate UI shows "no heartbeat yet" indefinitely
   * because `/api/agent/heartbeat` requires `{delegationId}` in body.
   *
   * Originally declared on `ContainerInput.delegationId` (line 89) per
   * `.omc/plans/stuck-delegation-spawn-failure.md` Phase 4 "Bug D" but
   * never threaded through here — observed live 2026-05-16 on task
   * cmndofiid00017fvp3dx0dgi3.
   */
  delegationId?: string,
  /**
   * In-run cascade override: forces CLAUDE_AGENT_MODEL to a funded fallback
   * model (routed via the gateway) instead of the default. Set only on the
   * single retry after a primary credit/429 failure.
   */
  forceModel?: string,
): Promise<{
  args: string[];
  oauthHardFail: boolean;
  credentialsResolved: boolean;
  resolvedMode: 'api_key' | 'oauth' | 'none';
  /** LLMProvider row id of the picked credential (for cooldown attribution). */
  pickedCredentialId?: string;
  /** Workspace owning the picked credential (cooldown payload). */
  pickedWorkspaceId?: string;
  /** Ordered funded fallback bundle (OpenAI/Gemini) for the in-run cascade. */
  pickedFallbacks?: { provider: string; key: string; baseUrl: string | null }[];
}> {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Inject workspace context for per-workspace credential resolution
  if (workspaceId) {
    args.push('-e', `DELEGATE_WORKSPACE_ID=${workspaceId}`);
  }

  // Heartbeat plumbing — the agent-runner posts `/api/agent/heartbeat`
  // every 60s with this id so the Delegate UI's status pill flips
  // OFFLINE → LIVE and the orphan reaper can distinguish stuck work from
  // live work. Without this env the heartbeat poster has nothing to send.
  if (delegationId) {
    args.push('-e', `DELEGATE_DELEGATION_ID=${delegationId}`);
  }

  // Phase 2.5b' — workflow artifacts root inside the container. Set only
  // when the run was started by the DAG executor (channel-driven invocations
  // leave this undefined and the env var is absent).
  if (workflowArtifactsContainerPath) {
    args.push('-e', `WORKFLOW_ARTIFACTS_DIR=${workflowArtifactsContainerPath}`);
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

  // Phase 2 / Phase 7: Mint a per-workspace JWT for this container. The minted
  // JWT is (a) injected into the container env as DELEGATE_AGENT_JWT, AND (b)
  // used by the ORCHESTRATOR-SIDE credential resolution below
  // (resolveLLMKeysFromDelegate) because the platform's
  // `/api/agent/integrations/llm-keys` route is now JWT-ONLY (Phase 7 Sub-step
  // 7.7b) and hard-rejects the legacy shared bearer with 401. Without threading
  // the JWT into the resolver call, Tier-1 per-workspace key resolution 401s
  // and silently falls back to static/Bifrost credentials.
  let mintedAgentJwt: string | null = null;
  if (workspaceId) {
    try {
      const { mintAgentJWT } = await import('./jwt-mint.js');
      const minted = await mintAgentJWT({ workspaceId });
      if (minted) {
        mintedAgentJwt = minted.jwt;
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
  // Picked-credential attribution for post-run cooldown (credit_exhausted /
  // rate_limit). Threaded out so runContainerAgent's close handler can report
  // the dead row to Delegate, advancing the next dispatch past it.
  let pickedCredentialId: string | undefined;
  let pickedWorkspaceId: string | undefined;
  let pickedFallbacks: {
    provider: string;
    key: string;
    baseUrl: string | null;
  }[] = [];

  // Tier 1: Per-workspace keys from Delegate API (preferred for multi-tenant SaaS)
  if (workspaceId) {
    try {
      const { resolveLLMKeysFromDelegate } =
        await import('./credential-client.js');
      // Pass the minted per-workspace JWT so the JWT-only credential route
      // (Phase 7 Sub-step 7.7b) accepts the request. Falls back to the legacy
      // bearer inside the client only when no JWT was minted.
      const keys = await resolveLLMKeysFromDelegate(
        workspaceId,
        requestingUserId,
        mintedAgentJwt,
      );
      // `providerId` is present on the oauth + api_key union branches (not the
      // exhausted/no-cred branches) — narrow with `in` before reading.
      if (keys && 'providerId' in keys && keys.providerId) {
        pickedCredentialId = keys.providerId;
        pickedWorkspaceId = workspaceId;
      }
      // Funded fallback bundle (OpenAI/Gemini) for the in-run cascade. Threaded
      // out so the close handler can re-spawn once against a funded model
      // (routed through the gateway by Bifrost) on a primary 402/429.
      if (keys && 'fallbacks' in keys && Array.isArray(keys.fallbacks)) {
        pickedFallbacks = keys.fallbacks;
      }

      // Phase 5 branch A — OAuth picked AND token present.
      // Inject ONLY CLAUDE_CODE_OAUTH_TOKEN. Deliberately skip
      // ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL — OAuth speaks
      // api.anthropic.com directly without going through Bifrost.
      if (keys?.mode === 'oauth' && keys.oauthToken) {
        args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${keys.oauthToken}`);
        args.push('-e', `DELEGATE_LLM_PROVIDER_ID=${keys.providerId}`); // in-container hook reads this for cooldown reporting
        args.push('-e', `DELEGATE_LLM_WORKSPACE_ID=${workspaceId}`); // for cooldown payload
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
      else if (keys?.mode === 'api_key' && keys.anthropicKey) {
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
      if (
        keys &&
        keys.pickedScope !== 'exhausted' &&
        keys.openaiKey &&
        !credentialsResolved
      ) {
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
      // Funded-fallback bundle for the static (no-workspace) path. The static
      // key is the platform gateway VK, so the same gateway-routed openai +
      // gemini rungs are reachable through it on a primary credit/429 — the
      // in-run cascade re-runs with CLAUDE_AGENT_MODEL forced to each rung's
      // model (still over this VK + ANTHROPIC_BASE_URL). Without this, a static
      // dispatch (e.g. the Main Agent) had an EMPTY bundle and aborted at the
      // first credit error with "no funded fallback available" even though
      // Gemini was funded. The key/baseUrl mirror the primary; only `provider`
      // is consumed by the cascade (→ fallbackModelForProvider).
      pickedFallbacks = [
        {
          provider: 'openai',
          key: BIFROST_KEY,
          baseUrl: `${containerBifrostUrl}/anthropic`,
        },
        {
          provider: 'gemini',
          key: BIFROST_KEY,
          baseUrl: `${containerBifrostUrl}/anthropic`,
        },
      ];
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

  // ── Model selection ────────────────────────────────────────────────────
  // The claude CLI defaults to `claude-sonnet-4-6` but many OAuth tokens
  // don't grant access to it yet — the CLI then returns the silent
  // "selected model... may not exist" trap wrapped in `status: success`.
  // Pick precedence:
  //   1. Host env CLAUDE_AGENT_MODEL (operator override)
  //   2. Delegate dispatcher injection via the request envelope (future:
  //      AgentProfile.delegateAgentModel — needs llm-keys API extension)
  //   3. Hardcoded fallback `claude-haiku-4-5-20251001`
  // Why haiku as the fallback and not sonnet/opus: the workspace-OAuth
  // tokens currently in rotation hit `rate_limit_error` on every premium
  // model (verified 2026-05-16 via /v1/messages probe — haiku was the
  // ONLY tier accepting the request without a 429). The CLI wraps that
  // as "selected model... may not exist or you may not have access" and
  // bubbles `status: success` back to the dispatcher, masking the
  // failure. Haiku is the safe default; operators with Sonnet/Opus
  // budget should set CLAUDE_AGENT_MODEL on the host OR per-agent via
  // AgentProfile.delegateAgentModel (future llm-keys API extension).
  // The agent-runner reads CLAUDE_AGENT_MODEL inside the container and
  // threads to query()'s `model` option (container/agent-runner/src/index.ts).
  // In-run cascade: `forceModel` (a funded fallback model routed via the
  // gateway) takes precedence on the retry after a primary 402/429.
  const agentModel =
    forceModel || process.env.CLAUDE_AGENT_MODEL || 'claude-haiku-4-5-20251001';
  args.push('-e', `CLAUDE_AGENT_MODEL=${agentModel}`);

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

  return {
    args,
    oauthHardFail,
    credentialsResolved,
    resolvedMode,
    pickedCredentialId,
    pickedWorkspaceId,
    pickedFallbacks,
  };
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

/**
 * Detect an LLM credit/rate-limit failure in container output. The agent's
 * claude-cli surfaces these as text in stdout/stderr (e.g. Anthropic
 * "Credit balance is too low", OpenRouter 402 "requires more credits",
 * or a 429 rate_limit/usage_limit). Returns the matching cooldown reason so
 * the picked credential row can be cooled — advancing the NEXT dispatch past
 * it. Returns null when no credit/rate-limit signature is present.
 *
 * NOTE: this gives cross-dispatch rotation. True in-run cascade (retry the
 * same task against a funded fallback provider) is a follow-up that consumes
 * the ordered `fallbacks[]` the llm-keys route now returns.
 */
export function detectCredentialFailure(
  text: string,
): 'usage_limit_exceeded' | 'rate_limit_unknown' | null {
  const t = text.toLowerCase();
  // 402 / credit-exhaustion (Anthropic + OpenRouter phrasings).
  if (
    t.includes('credit balance is too low') ||
    t.includes('requires more credits') ||
    t.includes('insufficient_quota') ||
    t.includes('insufficient credit')
  ) {
    return 'usage_limit_exceeded';
  }
  // 429 rate-limit / usage-limit.
  if (
    t.includes('usage_limit_exceeded') ||
    t.includes('rate_limit_error') ||
    t.includes('rate limit') ||
    t.includes('429')
  ) {
    return 'rate_limit_unknown';
  }
  return null;
}

/**
 * Map a funded fallback provider to the model id to request through the
 * Bifrost gateway. The container keeps ANTHROPIC_BASE_URL pointed at the
 * gateway; Bifrost translates and routes `gpt-4o` → OpenAI, `gemini-*` →
 * Gemini. claude-cli external-model support (code.claude.com model-config)
 * lets the agent-runner target these via CLAUDE_AGENT_MODEL.
 */
export function fallbackModelForProvider(provider: string): string | null {
  // CROSS-REPO LOCK-STEP with Delegate's GATEWAY_FUNDED_FALLBACK_MODELS
  // (lib/bifrost/gateway-funded-models.ts) + the managed-VK allow-list. These
  // ids MUST match, or the managed-gateway 402-cascade requests a model the VK
  // rejects (Bifrost 400 "model not allowed"). 2026-06-01: gemini-2.0-flash
  // (sunset, 404) → gemini-2.5-flash; gpt-4o → gpt-5.4-mini (matches Delegate).
  switch (provider) {
    case 'openai':
      return 'gpt-5.4-mini';
    case 'gemini':
      return 'gemini-2.5-flash';
    case 'openrouter':
      return 'openrouter/openai/gpt-4o-mini';
    default:
      return null;
  }
}

/**
 * Pick the next usable rung when walking the ordered funded-fallback bundle
 * during an in-run credit/429 cascade. Starting at `startIndex`, returns the
 * first rung whose provider maps to a real fallback model (skipping providers
 * with no model mapping), or `null` if the bundle is exhausted.
 *
 * This is the load-bearing decision of the cascade: walking (not just `[0]`)
 * is what lets an unfunded rung (e.g. OpenAI 429) fall through to a funded
 * rung (e.g. Gemini) instead of aborting with "no funded fallback available".
 * Bounded by `fallbacks.length` — the caller advances `startIndex` strictly,
 * so there is no loop. Exported for unit testing.
 */
export function selectNextCascadeRung(
  fallbacks: { provider: string }[],
  startIndex: number,
): { index: number; provider: string; forceModel: string } | null {
  for (let i = Math.max(0, startIndex); i < fallbacks.length; i++) {
    const forceModel = fallbackModelForProvider(fallbacks[i].provider);
    if (forceModel) {
      return { index: i, provider: fallbacks[i].provider, forceModel };
    }
  }
  return null;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  onEvent?: (event: AgentToolCallEvent) => void,
  // Internal: set on an in-run cascade retry after a primary 402/429. Forces
  // CLAUDE_AGENT_MODEL to a funded fallback model (routed via the gateway) and
  // records HOW FAR through the ordered `pickedFallbacks` bundle we've walked so
  // far. `fallbackIndex` is the index of the fallback whose model is being
  // forced on THIS retry; the close handler resumes the walk at
  // `fallbackIndex + 1` if this rung also exhausts, so an unfunded rung (e.g.
  // OpenAI 429) no longer aborts the cascade before a funded rung (e.g. Gemini)
  // is tried. Not part of the public contract.
  __cascade?: { forceModel: string; fallbackIndex: number },
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

  const mounts = await buildVolumeMounts(
    group,
    input.isMain,
    input.artifactsDir,
  );
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
    // When the workflow executor passes an artifactsDir, the container sees
    // it at /workspace/artifacts via buildVolumeMounts above; this exposes
    // the container-side path as WORKFLOW_ARTIFACTS_DIR for prompts/skills.
    input.artifactsDir ? '/workspace/artifacts' : undefined,
    // Thread the in-flight delegationId through so the heartbeat poster
    // in the agent-runner has something to send to /api/agent/heartbeat.
    input.delegationId,
    // In-run cascade retry: force the funded fallback model.
    __cascade?.forceModel,
  );
  const containerArgs = buildResult.args;
  const containerMode = buildResult.resolvedMode;
  // Picked-credential attribution for post-run cooldown on credit/429.
  const pickedCredentialId = buildResult.pickedCredentialId;
  const pickedWorkspaceId = buildResult.pickedWorkspaceId;
  const pickedFallbacks = buildResult.pickedFallbacks ?? [];

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
    // Set when a streamed OUTPUT marker carries a credit/rate-limit failure that
    // the claude-cli mis-reported as `status:success` (e.g. result text
    // "API Error: 402 …"). The close handler reads this to force the cooldown +
    // cascade path even though the marker claimed success. We also stop the
    // container immediately so it doesn't linger idle until IDLE_TIMEOUT.
    let streamedCreditReason:
      | 'usage_limit_exceeded'
      | 'rate_limit_unknown'
      | null = null;

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
              // Credit/rate-limit mis-reported as success: the claude-cli can
              // return subtype=success with the upstream error embedded in the
              // result text ("API Error: 402 …"). Detect it here so we don't
              // treat it as a real result, and so the container is reaped now
              // instead of lingering idle until IDLE_TIMEOUT (which starves the
              // queue — observed 2026-05-25, 5 hung containers).
              if (!streamedCreditReason && typeof parsed.result === 'string') {
                const r = detectCredentialFailure(parsed.result);
                if (r) {
                  streamedCreditReason = r;
                  logger.warn(
                    { group: group.name, containerName, reason: r },
                    'Streamed OUTPUT carried a credit/rate-limit error mis-reported as success — stopping container for cooldown/cascade',
                  );
                  // Stop now; the close handler runs cooldown + cascade.
                  try {
                    stopContainer(containerName);
                  } catch {
                    container.kill('SIGKILL');
                  }
                }
              }
              // Activity detected — reset the hard timeout
              resetTimeout();
              // Call onOutput for all markers (including null results)
              // so idle timers start even for "silent" query completions.
              // Suppress the bogus "success" result when it's actually a credit
              // failure — don't hand the agent a result of "API Error: 402…".
              if (onOutput && !streamedCreditReason) {
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

      // Credit/rate-limit handling. Two responses, both gated on detecting a
      // credit-exhaustion / rate-limit signature in the run output:
      //   1. Cooldown the picked credential row (cross-dispatch rotation) so
      //      the NEXT dispatch's picker skips it (cooldown_until > now()).
      //   2. In-run cascade: if a funded fallback (OpenAI/Gemini) is available
      //      and this is NOT already a cascade retry, re-run the SAME task once
      //      with CLAUDE_AGENT_MODEL forced to the fallback model (Bifrost
      //      routes it via the gateway). Resolve the outer promise with that
      //      retry's result so the task completes instead of failing.
      // Prefer the streamed-OUTPUT detection (catches the claude-cli
      // "status:success + API Error: 402" case where the error is NOT in
      // stdout/stderr); fall back to scanning raw stdout/stderr.
      const creditReason =
        streamedCreditReason ?? detectCredentialFailure(`${stdout}\n${stderr}`);
      if (creditReason && pickedCredentialId && pickedWorkspaceId) {
        logger.warn(
          {
            group: group.name,
            containerName,
            providerId: pickedCredentialId,
            workspaceId: pickedWorkspaceId,
            reason: creditReason,
          },
          'Container hit credit/rate-limit — reporting cooldown so next dispatch rotates',
        );
        reportLLMCooldown({
          providerId: pickedCredentialId,
          workspaceId: pickedWorkspaceId,
          reason: creditReason,
        }).catch(() => {
          /* reported best-effort; cooldown-client logs its own failures */
        });
      }

      // In-run cascade — when we detected a credit failure, walk the ordered
      // `pickedFallbacks` bundle until a rung yields a usable model. Each retry
      // forces ONE fallback model; if that rung ALSO exhausts (e.g. an unfunded
      // OpenAI key 429s), the next close handler resumes the walk at the next
      // index rather than aborting. Bounded by the bundle length (no infinite
      // loop) — `fallbackIndex` strictly increases and we stop at the end.
      //
      // Why a walk and not just `[0]`: the bundle is ordered [openai, gemini].
      // When OpenAI is unfunded but Gemini is funded, the old single-shot
      // `[0]`-only cascade gave up at the OpenAI rung ("no funded fallback
      // available") and never reached the funded Gemini rung. (Observed live
      // 2026-06-20.)
      if (creditReason && pickedFallbacks.length > 0) {
        // Resume index: first rung on the initial failure, next rung on a
        // cascade-retry failure. `selectNextCascadeRung` skips rungs whose
        // provider has no model mapping and stops at the bundle's end.
        const startIndex = __cascade ? __cascade.fallbackIndex + 1 : 0;
        const rung = selectNextCascadeRung(pickedFallbacks, startIndex);
        if (rung) {
          const { index: nextIndex, provider, forceModel } = rung;
          clearTimeout(timeout);
          logger.warn(
            {
              group: group.name,
              containerName,
              fallbackProvider: provider,
              fallbackIndex: nextIndex,
              fallbackCount: pickedFallbacks.length,
              forceModel,
              reason: creditReason,
            },
            'Primary credential exhausted — cascading in-run to funded fallback model via gateway',
          );
          finalize(
            'error',
            code,
            `credit_exhausted → cascade to ${forceModel} (rung ${nextIndex + 1}/${pickedFallbacks.length})`,
          );
          // Re-run the same task with this fallback model forced, recording the
          // rung so a subsequent exhaustion resumes at the next rung.
          runContainerAgent(group, input, onProcess, onOutput, onEvent, {
            forceModel,
            fallbackIndex: nextIndex,
          })
            .then(resolve)
            .catch(() => {
              resolve({
                status: 'error',
                result: null,
                error: `Primary credential exhausted; cascade retry to ${forceModel} failed.`,
              });
            });
          return;
        }
        // No remaining rung maps to a model — fall through to the explicit
        // "no funded fallback available" error below.
      }

      // Streamed credit failure with no usable fallback to cascade to: resolve
      // as an explicit error (cooldown already fired above) instead of letting
      // the mis-reported `status:success` marker surface "API Error: 402…" as a
      // successful result.
      if (streamedCreditReason && !timedOut) {
        finalize('error', code, `credit_exhausted: ${streamedCreditReason}`);
        resolve({
          status: 'error',
          result: null,
          newSessionId,
          error: `Credit/rate-limit exhausted (${streamedCreditReason}); no funded fallback available.`,
        });
        return;
      }

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
