/**
 * Tests for the OAuth credential branch in buildContainerArgs.
 * Authoritative spec: .omc/plans/credential-mode-toggle.md AC8 +
 * AC-OAUTH-HARD-FAIL-NO-BIFROST.
 *
 * Strategy: buildContainerArgs is private. We exercise it via the public
 * runContainerAgent path and spy on `child_process.spawn`'s argv to verify
 * which env vars were injected.
 *
 * Covers:
 *  - Branch A (oauth + token)   : CLAUDE_CODE_OAUTH_TOKEN injected; NO
 *    ANTHROPIC_API_KEY or ANTHROPIC_BASE_URL.
 *  - Branch B (oauth no token)  : oauthHardFail short-circuits; container is
 *    NEVER spawned; NEITHER OAuth token NOR Bifrost key reach the args.
 *  - Branch C (api_key)         : ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL
 *    injected (existing behaviour preserved).
 *  - Missing `mode` field       : back-compat path uses api_key branch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// ─── Module mocks (must come before importing container-runner) ──────────────

vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'delegateagent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  DATA_DIR: '/tmp/delegateagent-test-data',
  GROUPS_DIR: '/tmp/delegateagent-test-groups',
  IDLE_TIMEOUT: 1800000,
  ONECLI_API_KEY: '',
  ONECLI_URL: 'http://localhost:10254',
  TIMEZONE: 'America/Los_Angeles',
  getEnvWithFallback: (primary: string, legacy: string[] = []) => {
    const v = process.env[primary];
    if (v) return v;
    for (const k of legacy) if (process.env[k]) return process.env[k];
    return undefined;
  },
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

// OneCLI applyContainerConfig MUST return false so it does NOT inject creds —
// otherwise Tier 2 would always succeed and mask the Tier 1 branches under test.
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = vi.fn().mockResolvedValue(false);
    createAgent = vi.fn().mockResolvedValue({ id: 'test' });
    ensureAgent = vi
      .fn()
      .mockResolvedValue({ name: 'test', identifier: 'test', created: true });
  },
}));

// Sentry breadcrumb / agent JWT mint dependencies that come through dynamic
// imports.  Stub them out so they don't tug in real auth.
vi.mock('./jwt-mint.js', () => ({
  mintAgentJWT: vi.fn().mockResolvedValue(null),
}));

// The credential-client is dynamic-imported inside buildContainerArgs.
// We mock at the module level so all dynamic imports see the same fn.
const resolveLLMKeysFromDelegate = vi.fn();
vi.mock('./credential-client.js', () => ({
  resolveLLMKeysFromDelegate,
}));

// The skills-client is dynamic-imported inside buildVolumeMounts when
// group.workspaceId is set. Without this mock the real `agentFetch` runs and
// the network call (10s AbortSignal.timeout) exceeds waitForSpawn's ~50ms
// budget, making spawn appear never invoked.
vi.mock('./skills-client.js', () => ({
  fetchSkillsFromDelegate: vi.fn().mockResolvedValue([]),
}));

function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;
const spawnSpy = vi.fn(() => fakeProc);

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: (...args: unknown[]) =>
      (spawnSpy as unknown as (...args: unknown[]) => unknown)(...args),
    execSync: vi.fn(() => Buffer.from('')), // docker image inspect passes
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent } from './container-runner.js';
import { recordCredentialAttempt } from './metrics.js';
import type { RegisteredGroup } from './types.js';

vi.mock('./metrics.js', async () => {
  const actual =
    await vi.importActual<typeof import('./metrics.js')>('./metrics.js');
  return {
    ...actual,
    recordCredentialAttempt: vi.fn(),
    recordCredentialResolution: vi.fn(),
    recordContainerSpawn: vi.fn(),
    recordContainerExit: vi.fn(),
  };
});

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
  workspaceId: 'ws_1', // required for Tier 1 to run
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'delegate:task:t_1',
  isMain: false,
  requestingUserId: 'u_1',
};

beforeEach(() => {
  spawnSpy.mockClear();
  resolveLLMKeysFromDelegate.mockReset();
  (recordCredentialAttempt as ReturnType<typeof vi.fn>).mockClear();
  fakeProc = createFakeProcess();
  // Ensure no static Bifrost key leaks in from the host env across runs.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
});

afterEach(() => {
  vi.useRealTimers();
});

/** Helper: yield to the event loop until spawn is called (or timeout). */
async function waitForSpawn(maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (spawnSpy.mock.calls.length > 0) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('spawn never invoked');
}

/** Helper: extract all env-var injections (-e KEY=VAL) into a Map. */
function extractEnvFromArgs(args: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-e') {
      const kv = args[i + 1];
      const idx = kv.indexOf('=');
      if (idx > 0) {
        out.set(kv.slice(0, idx), kv.slice(idx + 1));
      }
    }
  }
  return out;
}

describe('container-runner — OAuth credential branch', () => {
  it('branch A: oauth + token → CLAUDE_CODE_OAUTH_TOKEN, no ANTHROPIC_API_KEY', async () => {
    resolveLLMKeysFromDelegate.mockResolvedValue({
      mode: 'oauth',
      oauthToken: 'sk-ant-oat01-test',
      pickedScope: 'workspace',
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    // Wait until spawn is invoked (dynamic-import + Tier 1 fetch happen first).
    await waitForSpawn();
    // End stdout/stderr first so the readable streams quiesce, then emit close.
    fakeProc.stdout.end();
    fakeProc.stderr.end();
    fakeProc.emit('close', 0);
    await resultPromise;

    expect(spawnSpy).toHaveBeenCalledOnce();
    const args = spawnSpy.mock.calls[0][1] as string[];
    const env = extractEnvFromArgs(args);

    expect(env.get('CLAUDE_CODE_OAUTH_TOKEN')).toBe('sk-ant-oat01-test');
    // Branch A MUST NOT inject Anthropic API key or base URL — OAuth speaks
    // api.anthropic.com directly.
    expect(env.has('ANTHROPIC_API_KEY')).toBe(false);
    expect(env.has('ANTHROPIC_BASE_URL')).toBe(false);
  });

  it('branch B: oauth + missing token → oauthHardFail, container NEVER spawned', async () => {
    resolveLLMKeysFromDelegate.mockResolvedValue({
      mode: 'oauth',
      oauthToken: undefined,
      pickedScope: 'workspace',
    });
    // Even with a static Bifrost key set, the hard-fail branch MUST NOT use it.
    process.env.ANTHROPIC_API_KEY = 'sk-bifrost-WOULD-LEAK';

    const result = await runContainerAgent(testGroup, testInput, () => {});

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/^oauth_token_missing:/);
    // The load-bearing assertion: the container was NEVER spawned, so no
    // possibility of a Bifrost fallback even on the host process side.
    expect(spawnSpy).not.toHaveBeenCalled();
    // Metric fires for the missing-token outcome.
    expect(recordCredentialAttempt).toHaveBeenCalledWith(
      'workspace',
      'oauth_missing_token',
    );
  });

  it('branch C: api_key path → ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL', async () => {
    resolveLLMKeysFromDelegate.mockResolvedValue({
      mode: 'api_key',
      anthropicKey: 'sk-workspace-vk',
      anthropicBaseUrl: 'https://bifrost.delegate.ws/anthropic',
      pickedScope: 'workspace',
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await waitForSpawn();
    fakeProc.stdout.end();
    fakeProc.stderr.end();
    fakeProc.emit('close', 0);
    await resultPromise;

    expect(spawnSpy).toHaveBeenCalledOnce();
    const args = spawnSpy.mock.calls[0][1] as string[];
    const env = extractEnvFromArgs(args);

    expect(env.get('ANTHROPIC_API_KEY')).toBe('sk-workspace-vk');
    expect(env.get('ANTHROPIC_BASE_URL')).toBe(
      'https://bifrost.delegate.ws/anthropic',
    );
    expect(env.has('CLAUDE_CODE_OAUTH_TOKEN')).toBe(false);
  });

  it('back-compat: missing `mode` field → treated as api_key', async () => {
    // Old Delegate deploys returned the payload without `mode`. The client
    // normalises this to mode='api_key', which then hits Branch C if an
    // anthropicKey is present.
    resolveLLMKeysFromDelegate.mockResolvedValue({
      mode: 'api_key', // normalised by credential-client
      anthropicKey: 'sk-legacy',
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await waitForSpawn();
    fakeProc.stdout.end();
    fakeProc.stderr.end();
    fakeProc.emit('close', 0);
    await resultPromise;

    expect(spawnSpy).toHaveBeenCalledOnce();
    const args = spawnSpy.mock.calls[0][1] as string[];
    const env = extractEnvFromArgs(args);
    expect(env.get('ANTHROPIC_API_KEY')).toBe('sk-legacy');
    expect(env.has('CLAUDE_CODE_OAUTH_TOKEN')).toBe(false);
  });
});
