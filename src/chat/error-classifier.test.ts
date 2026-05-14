// ─── error-classifier tests ───
// Phase 3.2 of `.omc/plans/agent-path-credential-failover.md`.
// Mirrors platform fallback.ts:37-130 classify behavior.

import { describe, it, expect } from 'vitest';
import {
  classifyChatError,
  classifyChatErrorFromError,
} from './error-classifier.js';

describe('classifyChatError — taxonomy', () => {
  it('[credit-402] status:402 → credit_exhausted + shouldReportCooldown:true', () => {
    const c = classifyChatError({ status: 402, body: 'Payment required' });
    expect(c.kind).toBe('credit_exhausted');
    expect(c.shouldReportCooldown).toBe(true);
    expect(c.retryable).toBe(false);
  });

  it("[credit-body] status:400 body:'Your credit balance is too low' → credit_exhausted (today's prod failure signature)", () => {
    const c = classifyChatError({
      status: 400,
      body: 'Your credit balance is too low to make this request',
    });
    expect(c.kind).toBe('credit_exhausted');
    expect(c.shouldReportCooldown).toBe(true);
  });

  it('[auth-401] status:401 → auth_invalid + shouldReportCooldown:true', () => {
    const c = classifyChatError({ status: 401, body: 'unauthorized' });
    expect(c.kind).toBe('auth_invalid');
    expect(c.shouldReportCooldown).toBe(true);
  });

  it('[rate-429] status:429 → rate_limited + shouldReportCooldown:false', () => {
    const c = classifyChatError({ status: 429, body: 'rate limited' });
    expect(c.kind).toBe('rate_limited');
    expect(c.shouldReportCooldown).toBe(false);
    expect(c.retryable).toBe(true);
  });

  it('[server-503] status:503 → server_error', () => {
    const c = classifyChatError({ status: 503, body: 'service unavailable' });
    expect(c.kind).toBe('server_error');
    expect(c.retryable).toBe(true);
    expect(c.shouldReportCooldown).toBe(false);
  });

  it('[network/timeout] AbortError → timeout', () => {
    const ab = new Error('aborted');
    ab.name = 'AbortError';
    const c = classifyChatError({ error: ab });
    expect(c.kind).toBe('timeout');
    expect(c.retryable).toBe(true);
  });

  it('[unknown] status:418 → unknown', () => {
    const c = classifyChatError({ status: 418, body: "I'm a teapot" });
    expect(c.kind).toBe('unknown');
    expect(c.shouldReportCooldown).toBe(false);
  });
});

describe('classifyChatErrorFromError — synthesizes from thrown Error', () => {
  it('extracts status:body from "Anthropic-direct 402: ..." → credit_exhausted', () => {
    const err = new Error('Anthropic-direct 402: Payment required');
    expect(classifyChatErrorFromError(err)).toBe('credit_exhausted');
  });

  it('extracts status:body from "Bifrost 401: invalid_api_key" → auth_invalid', () => {
    const err = new Error('Bifrost 401: invalid_api_key for vk');
    expect(classifyChatErrorFromError(err)).toBe('auth_invalid');
  });

  it('falls back to body-signature when no status prefix → credit_exhausted', () => {
    const err = new Error('Your credit balance is too low');
    expect(classifyChatErrorFromError(err)).toBe('credit_exhausted');
  });

  it('null/undefined → unknown', () => {
    expect(classifyChatErrorFromError(null)).toBe('unknown');
    expect(classifyChatErrorFromError(undefined)).toBe('unknown');
  });
});
