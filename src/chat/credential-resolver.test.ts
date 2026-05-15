// ─── credential-resolver tests ───
//
// Covers the 4 TransportSpec variants + null-fallback + no-workspace + no-
// agent-token paths + cache behavior (30s success / 5s exhausted / null
// not cached / per-workspace key isolation).
//
// Pattern mirrors credential-client.oauth-shape.test.ts — vi.resetModules +
// fresh import so the resolver re-reads BIFROST_URL/BIFROST_VK at module
// init. The underlying `resolveLLMKeysFromDelegate` is mocked via
// `vi.mock('../credential-client.js')`.

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from 'vitest';

const ORIGINAL_TOKEN = process.env.DELEGATE_AGENT_TOKEN;
const ORIGINAL_API_KEY = process.env.DELEGATE_API_KEY;
const ORIGINAL_NANOCLAW_TOKEN = process.env.NANOCLAW_TOKEN;
const ORIGINAL_BIFROST_URL = process.env.BIFROST_URL;
const ORIGINAL_BIFROST_VK = process.env.BIFROST_VK;
const ORIGINAL_ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

vi.mock('../credential-client.js', () => ({
  resolveLLMKeysFromDelegate: vi.fn(),
}));

import { resolveLLMKeysFromDelegate } from '../credential-client.js';
const resolveMock = resolveLLMKeysFromDelegate as unknown as Mock;

async function importFresh() {
  vi.resetModules();
  return await import('./credential-resolver.js');
}

function restoreEnv(name: string, original: string | undefined): void {
  if (original !== undefined) process.env[name] = original;
  else delete process.env[name];
}

beforeEach(() => {
  process.env.DELEGATE_AGENT_TOKEN = 'test-bearer';
  process.env.BIFROST_URL = 'http://bifrost.test';
  process.env.BIFROST_VK = 'env-vk-default';
  resolveMock.mockReset();
});

afterEach(() => {
  restoreEnv('DELEGATE_AGENT_TOKEN', ORIGINAL_TOKEN);
  restoreEnv('DELEGATE_API_KEY', ORIGINAL_API_KEY);
  restoreEnv('NANOCLAW_TOKEN', ORIGINAL_NANOCLAW_TOKEN);
  restoreEnv('BIFROST_URL', ORIGINAL_BIFROST_URL);
  restoreEnv('BIFROST_VK', ORIGINAL_BIFROST_VK);
  restoreEnv('ANTHROPIC_API_KEY', ORIGINAL_ANTHROPIC_KEY);
});

describe('resolveChatTransport — functional branches', () => {
  it("[oauth-token-present] returns kind='skip-to-container' when resolver emits oauth+token", async () => {
    resolveMock.mockResolvedValue({
      mode: 'oauth',
      oauthToken: 'sk-ant-oat01-EXAMPLE',
      providerId: 'p_1',
      pickedScope: 'personal',
    });
    const { resolveChatTransport, _clearCacheForTests } = await importFresh();
    _clearCacheForTests();
    const spec = await resolveChatTransport({
      workspaceId: 'w1',
      userId: 'u1',
    });
    expect(spec.kind).toBe('skip-to-container');
    if (spec.kind === 'skip-to-container') {
      expect(spec.workspaceId).toBe('w1');
      expect(spec.reason).toBe('oauth-mode-container-only');
    }
  });

  it("[oauth-exhausted] returns kind='exhausted' when resolver emits oauth+token=null+pickedScope=exhausted", async () => {
    resolveMock.mockResolvedValue({
      mode: 'oauth',
      oauthToken: null,
      pickedScope: 'exhausted',
    });
    const { resolveChatTransport, _clearCacheForTests } = await importFresh();
    _clearCacheForTests();
    const spec = await resolveChatTransport({
      workspaceId: 'w1',
      userId: 'u1',
    });
    expect(spec.kind).toBe('exhausted');
    if (spec.kind === 'exhausted') expect(spec.workspaceId).toBe('w1');
  });

  it("[api_key-baseurl] returns kind='api_key' with custom URL + x-api-key when anthropicBaseUrl set", async () => {
    resolveMock.mockResolvedValue({
      mode: 'api_key',
      anthropicKey: 'sk-workspace-key',
      anthropicBaseUrl: 'https://workspace.bifrost.example.com/anthropic',
      providerId: 'p_ws',
      pickedScope: 'workspace',
    });
    const { resolveChatTransport, _clearCacheForTests } = await importFresh();
    _clearCacheForTests();
    const spec = await resolveChatTransport({
      workspaceId: 'w1',
      userId: 'u1',
    });
    expect(spec.kind).toBe('api_key');
    if (spec.kind === 'api_key') {
      expect(spec.url).toBe(
        'https://workspace.bifrost.example.com/anthropic/v1/messages',
      );
      expect(spec.headers['x-api-key']).toBe('sk-workspace-key');
      expect(spec.headers['anthropic-version']).toBe('2023-06-01');
      expect(spec.headers['x-bf-vk']).toBeUndefined();
      expect(spec.providerId).toBe('p_ws');
      expect(spec.pickedScope).toBe('workspace');
      expect(spec.workspaceId).toBe('w1');
    }
  });

  it("[api_key-bare] returns kind='api_key' against system Bifrost with x-bf-vk when no anthropicBaseUrl", async () => {
    resolveMock.mockResolvedValue({
      mode: 'api_key',
      anthropicKey: 'sk-system-vk',
      anthropicBaseUrl: null,
      providerId: 'p_sys',
      pickedScope: 'system',
    });
    const { resolveChatTransport, _clearCacheForTests } = await importFresh();
    _clearCacheForTests();
    const spec = await resolveChatTransport({
      workspaceId: 'w1',
      userId: 'u1',
    });
    expect(spec.kind).toBe('api_key');
    if (spec.kind === 'api_key') {
      expect(spec.url).toBe('http://bifrost.test/anthropic/v1/messages');
      expect(spec.headers['x-bf-vk']).toBe('sk-system-vk');
      expect(spec.headers['x-api-key']).toBeUndefined();
      expect(spec.providerId).toBe('p_sys');
      expect(spec.pickedScope).toBe('system');
    }
  });

  it("[null-fallback] returns kind='bifrost-env' when resolver returns null", async () => {
    resolveMock.mockResolvedValue(null);
    const { resolveChatTransport, _clearCacheForTests } = await importFresh();
    _clearCacheForTests();
    const spec = await resolveChatTransport({
      workspaceId: 'w1',
      userId: 'u1',
    });
    expect(spec.kind).toBe('bifrost-env');
    if (spec.kind === 'bifrost-env') {
      expect(spec.url).toBe('http://bifrost.test/anthropic/v1/messages');
      expect(spec.headers['x-bf-vk']).toBe('env-vk-default');
    }
  });

  it("[no-workspace] returns kind='bifrost-env' immediately when workspaceId missing — resolver NOT called", async () => {
    const { resolveChatTransport, _clearCacheForTests } = await importFresh();
    _clearCacheForTests();
    const spec = await resolveChatTransport({});
    expect(spec.kind).toBe('bifrost-env');
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("[no-agent-token] returns kind='bifrost-env' when DELEGATE_AGENT_TOKEN empty — resolver NOT called", async () => {
    delete process.env.DELEGATE_AGENT_TOKEN;
    delete process.env.DELEGATE_API_KEY;
    delete process.env.NANOCLAW_TOKEN;
    const { resolveChatTransport, _clearCacheForTests } = await importFresh();
    _clearCacheForTests();
    const spec = await resolveChatTransport({ workspaceId: 'w1' });
    expect(spec.kind).toBe('bifrost-env');
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('[warn-once-per-workspace] warns up to 5 times per workspace when workspaceId supplied but agent token empty', async () => {
    delete process.env.DELEGATE_AGENT_TOKEN;
    delete process.env.DELEGATE_API_KEY;
    delete process.env.NANOCLAW_TOKEN;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { resolveChatTransport, _clearCacheForTests } = await importFresh();
    _clearCacheForTests();
    for (let i = 0; i < 8; i++) {
      await resolveChatTransport({ workspaceId: 'w_warn' });
    }
    expect(warnSpy).toHaveBeenCalledTimes(5);
    warnSpy.mockRestore();
  });
});

describe('resolveChatTransport — cache behavior', () => {
  it('caches api_key success for 30s — two calls within window → resolver called ONCE', async () => {
    vi.useFakeTimers();
    resolveMock.mockResolvedValue({
      mode: 'api_key',
      anthropicKey: 'sk-x',
      anthropicBaseUrl: 'https://x.example.com',
      providerId: 'p',
      pickedScope: 'workspace',
    });
    const { resolveChatTransport, _clearCacheForTests } = await importFresh();
    _clearCacheForTests();
    await resolveChatTransport({ workspaceId: 'w_cache', userId: 'u' });
    vi.advanceTimersByTime(20_000);
    await resolveChatTransport({ workspaceId: 'w_cache', userId: 'u' });
    expect(resolveMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('expires api_key cache after 30s — calls 35s apart → resolver called TWICE', async () => {
    vi.useFakeTimers();
    resolveMock.mockResolvedValue({
      mode: 'api_key',
      anthropicKey: 'sk-y',
      anthropicBaseUrl: null,
      providerId: 'p',
      pickedScope: 'workspace',
    });
    const { resolveChatTransport, _clearCacheForTests } = await importFresh();
    _clearCacheForTests();
    await resolveChatTransport({ workspaceId: 'w_ttl', userId: 'u' });
    vi.advanceTimersByTime(35_000);
    await resolveChatTransport({ workspaceId: 'w_ttl', userId: 'u' });
    expect(resolveMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('caches exhausted only 5s — two calls within window → resolver called ONCE, calls 7s apart → TWICE', async () => {
    vi.useFakeTimers();
    resolveMock.mockResolvedValue({
      mode: 'oauth',
      oauthToken: null,
      pickedScope: 'exhausted',
    });
    const { resolveChatTransport, _clearCacheForTests } = await importFresh();
    _clearCacheForTests();
    await resolveChatTransport({ workspaceId: 'w_ex', userId: 'u' });
    vi.advanceTimersByTime(3_000);
    await resolveChatTransport({ workspaceId: 'w_ex', userId: 'u' });
    expect(resolveMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000); // total 8s
    await resolveChatTransport({ workspaceId: 'w_ex', userId: 'u' });
    expect(resolveMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('different workspaceIds → cache key isolation, resolver called per workspace', async () => {
    resolveMock.mockResolvedValue({
      mode: 'api_key',
      anthropicKey: 'sk',
      anthropicBaseUrl: null,
      providerId: 'p',
      pickedScope: 'workspace',
    });
    const { resolveChatTransport, _clearCacheForTests } = await importFresh();
    _clearCacheForTests();
    await resolveChatTransport({ workspaceId: 'w_a', userId: 'u' });
    await resolveChatTransport({ workspaceId: 'w_b', userId: 'u' });
    await resolveChatTransport({ workspaceId: 'w_a', userId: 'u' });
    expect(resolveMock).toHaveBeenCalledTimes(2);
  });

  it('null resolver result is NOT cached — next call invokes resolver again', async () => {
    resolveMock.mockResolvedValue(null);
    const { resolveChatTransport, _clearCacheForTests } = await importFresh();
    _clearCacheForTests();
    await resolveChatTransport({ workspaceId: 'w_null', userId: 'u' });
    await resolveChatTransport({ workspaceId: 'w_null', userId: 'u' });
    expect(resolveMock).toHaveBeenCalledTimes(2);
  });
});
