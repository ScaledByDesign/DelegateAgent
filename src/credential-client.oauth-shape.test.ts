/**
 * Tests for credential-client return shape after Phase 5
 * (credential-mode-toggle plan §4 Step 5) and Phase 6 (oauth-key-pool plan §6b).
 *
 * Covers:
 *  - mode='oauth' + oauthToken + providerId propagated through (Phase 5/6)
 *  - mode='oauth' + oauthToken=null + pickedScope='exhausted' (Phase 6 pool exhaustion)
 *  - mode='api_key' + anthropicKey propagated through
 *  - Missing `mode` field (old Delegate deploys) defaults to 'api_key'
 *  - Non-ok HTTP response returns null
 *  - DELEGATE_AGENT_TOKEN missing returns null
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_TOKEN = process.env.DELEGATE_AGENT_TOKEN;
const ORIGINAL_API_KEY = process.env.DELEGATE_API_KEY;

beforeEach(() => {
  process.env.DELEGATE_AGENT_TOKEN = 'test-bearer';
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_TOKEN !== undefined) {
    process.env.DELEGATE_AGENT_TOKEN = ORIGINAL_TOKEN;
  } else {
    delete process.env.DELEGATE_AGENT_TOKEN;
  }
  if (ORIGINAL_API_KEY !== undefined) {
    process.env.DELEGATE_API_KEY = ORIGINAL_API_KEY;
  } else {
    delete process.env.DELEGATE_API_KEY;
  }
});

function mockFetch(body: unknown, ok = true): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    json: async () => body,
  } as Response);
}

async function importFresh() {
  vi.resetModules();
  // Re-import so the module re-reads DELEGATE_AGENT_TOKEN at module-init.
  return await import('./credential-client.js');
}

describe('resolveLLMKeysFromDelegate — Phase 5/6 discriminated union', () => {
  it("returns mode='oauth' + oauthToken + providerId when Delegate emits oauth payload", async () => {
    mockFetch({
      data: {
        mode: 'oauth',
        oauthToken: 'sk-ant-oat01-EXAMPLE',
        providerId: 'llm_provider_abc123',
        pickedScope: 'personal',
      },
    });
    const { resolveLLMKeysFromDelegate } = await importFresh();
    const out = await resolveLLMKeysFromDelegate('ws_1', 'u_1');
    expect(out).not.toBeNull();
    expect(out!.mode).toBe('oauth');
    // Narrow to oauth+token branch
    if (out!.mode === 'oauth' && out!.oauthToken) {
      expect(out.oauthToken).toBe('sk-ant-oat01-EXAMPLE');
      expect(out.providerId).toBe('llm_provider_abc123');
      expect(out.pickedScope).toBe('personal');
    } else {
      throw new Error('Expected oauth+token branch');
    }
  });

  it("returns exhausted branch when oauthToken=null and pickedScope='exhausted'", async () => {
    mockFetch({
      data: {
        mode: 'oauth',
        oauthToken: null,
        pickedScope: 'exhausted',
      },
    });
    const { resolveLLMKeysFromDelegate } = await importFresh();
    const out = await resolveLLMKeysFromDelegate('ws_1', 'u_1');
    expect(out).not.toBeNull();
    expect(out!.mode).toBe('oauth');
    expect(out!.oauthToken).toBeNull();
    expect(out!.pickedScope).toBe('exhausted');
  });

  it("returns mode='api_key' + anthropicKey when Delegate emits api_key payload", async () => {
    mockFetch({
      data: {
        mode: 'api_key',
        anthropicKey: 'sk-bifrost-vk',
        anthropicBaseUrl: 'https://bifrost.example.com/anthropic',
        pickedScope: 'workspace',
      },
    });
    const { resolveLLMKeysFromDelegate } = await importFresh();
    const out = await resolveLLMKeysFromDelegate('ws_1', 'u_1');
    expect(out).not.toBeNull();
    expect(out!.mode).toBe('api_key');
    // Narrow to api_key branch
    if (out!.mode === 'api_key') {
      expect(out.anthropicKey).toBe('sk-bifrost-vk');
      expect(out.anthropicBaseUrl).toBe(
        'https://bifrost.example.com/anthropic',
      );
      expect(out.pickedScope).toBe('workspace');
    } else {
      throw new Error('Expected api_key branch');
    }
  });

  it("defaults missing mode to 'api_key' (back-compat with old Delegate)", async () => {
    mockFetch({
      data: { anthropicKey: 'sk-legacy' }, // no `mode` field
    });
    const { resolveLLMKeysFromDelegate } = await importFresh();
    const out = await resolveLLMKeysFromDelegate('ws_1');
    expect(out).not.toBeNull();
    expect(out!.mode).toBe('api_key');
    if (out!.mode === 'api_key') {
      expect(out.anthropicKey).toBe('sk-legacy');
    }
  });

  it('passes both workspaceId and userId as query params', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { mode: 'api_key', anthropicKey: 'sk-x' } }),
    } as Response);
    globalThis.fetch = fetchSpy;
    const { resolveLLMKeysFromDelegate } = await importFresh();
    await resolveLLMKeysFromDelegate('ws_42', 'u_99');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toMatch(/workspaceId=ws_42/);
    expect(url).toMatch(/userId=u_99/);
  });

  it('returns null on non-2xx response', async () => {
    mockFetch({}, false);
    const { resolveLLMKeysFromDelegate } = await importFresh();
    const out = await resolveLLMKeysFromDelegate('ws_1');
    expect(out).toBeNull();
  });

  it('returns null when DELEGATE_AGENT_TOKEN is unset', async () => {
    delete process.env.DELEGATE_AGENT_TOKEN;
    delete process.env.DELEGATE_API_KEY;
    // No fetch should be made — short-circuits at the empty-token check.
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    const { resolveLLMKeysFromDelegate } = await importFresh();
    const out = await resolveLLMKeysFromDelegate('ws_1');
    expect(out).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
