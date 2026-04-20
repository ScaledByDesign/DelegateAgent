import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getEnvWithFallback } from './config.js';

describe('getEnvWithFallback', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DELEGATE_AGENT_TOKEN;
    delete process.env.NANOCLAW_TOKEN;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('prefers the primary env var when set', () => {
    process.env.DELEGATE_AGENT_TOKEN = 'new-token';
    process.env.NANOCLAW_TOKEN = 'legacy-token';
    expect(getEnvWithFallback('DELEGATE_AGENT_TOKEN', ['NANOCLAW_TOKEN'])).toBe(
      'new-token',
    );
  });

  it('falls back to a legacy env var when primary is missing', () => {
    process.env.NANOCLAW_TOKEN = 'legacy-token';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getEnvWithFallback('DELEGATE_AGENT_TOKEN', ['NANOCLAW_TOKEN'])).toBe(
      'legacy-token',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('NANOCLAW_TOKEN'),
    );
  });

  it('returns undefined when neither is set', () => {
    expect(
      getEnvWithFallback('DELEGATE_AGENT_TOKEN', ['NANOCLAW_TOKEN']),
    ).toBeUndefined();
  });

  it('walks multiple legacy vars in order', () => {
    process.env.OLDER_TOKEN = 'older';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      getEnvWithFallback('DELEGATE_AGENT_TOKEN', [
        'NANOCLAW_TOKEN',
        'OLDER_TOKEN',
      ]),
    ).toBe('older');
    expect(warn).toHaveBeenCalled();
  });
});
