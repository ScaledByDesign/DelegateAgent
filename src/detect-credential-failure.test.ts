import { describe, it, expect } from 'vitest';
import { detectCredentialFailure } from './container-runner.js';

// Unit spec for the credit/rate-limit detection that drives cross-dispatch
// credential cooldown. These are the exact upstream phrasings observed in
// production agent runs (Anthropic direct, OpenRouter, 429 rate-limit).

describe('detectCredentialFailure', () => {
  it('detects Anthropic credit exhaustion → usage_limit_exceeded', () => {
    const text =
      'agent: Your credit balance is too low to access the Anthropic API.';
    expect(detectCredentialFailure(text)).toBe('usage_limit_exceeded');
  });

  it('detects OpenRouter 402 "requires more credits" → usage_limit_exceeded', () => {
    const text =
      '{"error":{"message":"This request requires more credits, or fewer max_tokens..."}}';
    expect(detectCredentialFailure(text)).toBe('usage_limit_exceeded');
  });

  it('detects OpenAI insufficient_quota → usage_limit_exceeded', () => {
    expect(detectCredentialFailure('error: insufficient_quota')).toBe(
      'usage_limit_exceeded',
    );
  });

  it('detects 429 rate_limit_error → rate_limit_unknown', () => {
    const text = '{"type":"error","error":{"type":"rate_limit_error"}}';
    expect(detectCredentialFailure(text)).toBe('rate_limit_unknown');
  });

  it('detects a bare 429 status → rate_limit_unknown', () => {
    expect(detectCredentialFailure('HTTP 429: too many requests')).toBe(
      'rate_limit_unknown',
    );
  });

  it('prioritizes credit-exhaustion over rate-limit when both phrasings present', () => {
    // credit phrasing is checked first — a depleted key should cool as
    // usage_limit_exceeded even if "rate limit" also appears in the log noise.
    const text = 'credit balance is too low (also saw rate limit earlier)';
    expect(detectCredentialFailure(text)).toBe('usage_limit_exceeded');
  });

  it('returns null for a normal successful run', () => {
    const text = 'agent: OK, I analyzed the feature and produced a plan. Done.';
    expect(detectCredentialFailure(text)).toBeNull();
  });

  it('returns null for empty output', () => {
    expect(detectCredentialFailure('')).toBeNull();
  });
});
