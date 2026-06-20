import { describe, it, expect } from 'vitest';
import {
  selectNextCascadeRung,
  fallbackModelForProvider,
} from './container-runner.js';

// The ordered funded-fallback bundle the llm-keys route hands the container.
// Real-world shape observed live 2026-06-20: OpenAI first, Gemini second.
const BUNDLE = [{ provider: 'openai' }, { provider: 'gemini' }];

describe('selectNextCascadeRung — in-run credit/429 cascade walk', () => {
  it('initial failure picks the first rung (OpenAI)', () => {
    const r = selectNextCascadeRung(BUNDLE, 0);
    expect(r).toEqual({
      index: 0,
      provider: 'openai',
      forceModel: fallbackModelForProvider('openai'),
    });
  });

  it('REGRESSION: when the OpenAI rung exhausts, the walk continues to the funded Gemini rung (does NOT abort)', () => {
    // Simulate: primary 402 → cascaded to rung 0 (openai) → openai also 429.
    // The retry recorded fallbackIndex=0, so the resume index is 1.
    const r = selectNextCascadeRung(BUNDLE, 0 + 1);
    expect(r).not.toBeNull();
    expect(r!.index).toBe(1);
    expect(r!.provider).toBe('gemini');
    expect(r!.forceModel).toBe('gemini-2.5-flash');
  });

  it('returns null once the bundle is exhausted (last rung consumed)', () => {
    // Resume past the final rung (index 1) → nothing left → "no funded fallback".
    expect(selectNextCascadeRung(BUNDLE, 2)).toBeNull();
  });

  it('skips rungs whose provider has no model mapping', () => {
    const bundle = [
      { provider: 'mystery' }, // no mapping → skipped
      { provider: 'gemini' },
    ];
    const r = selectNextCascadeRung(bundle, 0);
    expect(r!.index).toBe(1);
    expect(r!.provider).toBe('gemini');
  });

  it('returns null for an empty bundle', () => {
    expect(selectNextCascadeRung([], 0)).toBeNull();
  });

  it('clamps a negative startIndex to 0', () => {
    const r = selectNextCascadeRung(BUNDLE, -5);
    expect(r!.index).toBe(0);
  });

  it('walks every rung exactly once across repeated exhaustion (bounded, no loop)', () => {
    const visited: number[] = [];
    let idx = 0;
    // Emulate the close-handler loop: each exhaustion resumes at index+1.
    for (let guard = 0; guard < 10; guard++) {
      const r = selectNextCascadeRung(BUNDLE, idx);
      if (!r) break;
      visited.push(r.index);
      idx = r.index + 1;
    }
    expect(visited).toEqual([0, 1]); // each rung once, then terminates
  });
});
