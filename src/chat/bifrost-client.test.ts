// ─── bifrost-client tests ───
//
// Phase 4.4 of `.omc/plans/agent-path-credential-failover.md`. Mocks both
// `global.fetch` and the credential-resolver so each test exercises a single
// TransportSpec variant deterministically. The two "skip / hard-fail" tests
// MUST include `expect(fetch).not.toHaveBeenCalled()` — that's the
// AC-OAUTH-HARD-FAIL-NO-BIFROST analogue for fast-path (Architect Q1 + Q2
// invariant: OAuth mode and exhausted pool NEVER hit the network from
// fast-path).

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from 'vitest';

vi.mock('./credential-resolver.js', async () => {
  const actual = await vi.importActual<
    typeof import('./credential-resolver.js')
  >('./credential-resolver.js');
  return {
    ...actual,
    resolveChatTransport: vi.fn(),
  };
});

vi.mock('../cooldown-client.js', () => ({
  reportLLMCooldown: vi.fn().mockResolvedValue(true),
}));

import {
  resolveChatTransport,
  CredentialsExhaustedError,
  SkipToContainerError,
} from './credential-resolver.js';
import { reportLLMCooldown } from '../cooldown-client.js';
import { chatComplete } from './bifrost-client.js';

const resolveMock = resolveChatTransport as unknown as Mock;
const cooldownMock = reportLLMCooldown as unknown as Mock;

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetchOk(text = 'hi back'): Mock {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: 'text', text }],
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    text: async () => '',
  } as Response);
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

function mockFetchErr(status: number, body: string): Mock {
  const fn = vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: 'error',
    json: async () => ({}),
    text: async () => body,
  } as Response);
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  resolveMock.mockReset();
  cooldownMock.mockReset();
  // Default impl — keeps Promise.resolve().then(...).catch() chain alive
  // when the test doesn't override. Tests that assert call args still see
  // the call via cooldownMock.mock.calls.
  cooldownMock.mockResolvedValue(true);
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('chatComplete — TransportSpec dispatch', () => {
  it("[api_key-baseurl-happy] transport={kind:'api_key', custom URL} → fetch called with x-api-key", async () => {
    resolveMock.mockResolvedValue({
      kind: 'api_key',
      url: 'https://workspace.example.com/v1/messages',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': 'sk-workspace',
      },
      providerId: 'p_ws',
      workspaceId: 'w1',
      pickedScope: 'workspace',
    });
    const fetchSpy = mockFetchOk('hello');
    const out = await chatComplete({
      system: 's',
      userMessage: 'u',
      workspaceId: 'w1',
      userId: 'u1',
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://workspace.example.com/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(
      'sk-workspace',
    );
    expect(out.transportMode).toBe('api_key');
    expect(out.text).toBe('hello');
  });

  it("[api_key-bare-happy] transport={kind:'api_key', bifrost URL} → fetch called with x-bf-vk", async () => {
    resolveMock.mockResolvedValue({
      kind: 'api_key',
      url: 'http://bifrost.test/anthropic/v1/messages',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-bf-vk': 'sk-system',
      },
      providerId: 'p_sys',
      workspaceId: 'w1',
      pickedScope: 'system',
    });
    const fetchSpy = mockFetchOk('reply');
    const out = await chatComplete({
      system: 's',
      userMessage: 'u',
      workspaceId: 'w1',
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://bifrost.test/anthropic/v1/messages');
    expect((init.headers as Record<string, string>)['x-bf-vk']).toBe(
      'sk-system',
    );
    expect(out.transportMode).toBe('api_key');
  });

  it("[bifrost-env-happy] transport={kind:'bifrost-env'} → fetch called with env x-bf-vk", async () => {
    resolveMock.mockResolvedValue({
      kind: 'bifrost-env',
      url: 'http://bifrost.test/anthropic/v1/messages',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-bf-vk': 'env-vk',
      },
    });
    const fetchSpy = mockFetchOk();
    const out = await chatComplete({ system: 's', userMessage: 'u' });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(out.transportMode).toBe('bifrost-env');
  });

  it('[exhausted] transport={kind:"exhausted"} → throws CredentialsExhaustedError + fetch NEVER called', async () => {
    resolveMock.mockResolvedValue({ kind: 'exhausted', workspaceId: 'w1' });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await expect(
      chatComplete({ system: 's', userMessage: 'u', workspaceId: 'w1' }),
    ).rejects.toBeInstanceOf(CredentialsExhaustedError);
    // AC-OAUTH-HARD-FAIL-NO-BIFROST analogue: NO network call on hard-fail.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('[skip-to-container] transport={kind:"skip-to-container"} → throws SkipToContainerError + fetch NEVER called', async () => {
    resolveMock.mockResolvedValue({
      kind: 'skip-to-container',
      workspaceId: 'w1',
      reason: 'oauth-mode-container-only',
    });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await expect(
      chatComplete({ system: 's', userMessage: 'u', workspaceId: 'w1' }),
    ).rejects.toBeInstanceOf(SkipToContainerError);
    // Architect Q1 invariant: OAuth mode never hits api.anthropic.com from fast-path.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('[credit-exhausted-response] api_key transport + 402 → throws + reports cooldown', async () => {
    resolveMock.mockResolvedValue({
      kind: 'api_key',
      url: 'https://x/v1/messages',
      headers: { 'x-api-key': 'k' },
      providerId: 'p_credit',
      workspaceId: 'w1',
      pickedScope: 'workspace',
    });
    mockFetchErr(402, 'Payment required');
    await expect(
      chatComplete({ system: 's', userMessage: 'u', workspaceId: 'w1' }),
    ).rejects.toThrow(/402/);
    // Fire-and-forget — drain microtasks before asserting.
    await new Promise((r) => setImmediate(r));
    expect(cooldownMock).toHaveBeenCalledOnce();
    const call = cooldownMock.mock.calls[0][0];
    expect(call.providerId).toBe('p_credit');
    expect(call.workspaceId).toBe('w1');
    expect(call.reason).toBe('usage_limit_exceeded');
  });

  it('[auth-invalid-response] api_key transport + 401 → throws + reports cooldown with auth_error', async () => {
    resolveMock.mockResolvedValue({
      kind: 'api_key',
      url: 'https://x/v1/messages',
      headers: { 'x-api-key': 'k' },
      providerId: 'p_auth',
      workspaceId: 'w1',
      pickedScope: 'workspace',
    });
    mockFetchErr(401, 'invalid_api_key');
    await expect(
      chatComplete({ system: 's', userMessage: 'u', workspaceId: 'w1' }),
    ).rejects.toThrow(/401/);
    await new Promise((r) => setImmediate(r));
    expect(cooldownMock).toHaveBeenCalledOnce();
    expect(cooldownMock.mock.calls[0][0].reason).toBe('auth_error');
  });

  it('[rate-limited-response] api_key transport + 429 → throws WITHOUT reporting cooldown', async () => {
    resolveMock.mockResolvedValue({
      kind: 'api_key',
      url: 'https://x/v1/messages',
      headers: { 'x-api-key': 'k' },
      providerId: 'p_rate',
      workspaceId: 'w1',
      pickedScope: 'workspace',
    });
    mockFetchErr(429, 'rate limited');
    await expect(
      chatComplete({ system: 's', userMessage: 'u', workspaceId: 'w1' }),
    ).rejects.toThrow(/429/);
    await new Promise((r) => setImmediate(r));
    expect(cooldownMock).not.toHaveBeenCalled();
  });
});
