import { describe, it, expect } from 'vitest';
import {
  redactSecretEnvArgs,
  redactInString,
  SENSITIVE_KEYS,
} from './log-redact.js';

// ─── redactSecretEnvArgs ──────────────────────────────────────────────────────

describe('redactSecretEnvArgs', () => {
  it('redacts two-token form: ["-e", "KEY=value"]', () => {
    const input = [
      'docker',
      'run',
      '-e',
      'ANTHROPIC_API_KEY=sk-ant-abc123',
      '--rm',
      'image:latest',
    ];
    const result = redactSecretEnvArgs(input);
    expect(result).toEqual([
      'docker',
      'run',
      '-e',
      'ANTHROPIC_API_KEY=<redacted>',
      '--rm',
      'image:latest',
    ]);
  });

  it('redacts CLAUDE_CODE_OAUTH_TOKEN in two-token form', () => {
    const input = ['-e', 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-supersecret'];
    const result = redactSecretEnvArgs(input);
    expect(result).toEqual(['-e', 'CLAUDE_CODE_OAUTH_TOKEN=<redacted>']);
  });

  it('redacts DELEGATE_AGENT_TOKEN', () => {
    const input = ['run', '-e', 'DELEGATE_AGENT_TOKEN=tok-secret', 'img'];
    expect(redactSecretEnvArgs(input)).toEqual([
      'run',
      '-e',
      'DELEGATE_AGENT_TOKEN=<redacted>',
      'img',
    ]);
  });

  it('redacts FORGETFUL_BEARER', () => {
    const input = ['-e', 'FORGETFUL_BEARER=bearer-secret-value'];
    expect(redactSecretEnvArgs(input)).toContain('FORGETFUL_BEARER=<redacted>');
  });

  it('redacts BIFROST_VK', () => {
    const input = ['-e', 'BIFROST_VK=vk-super-secret'];
    expect(redactSecretEnvArgs(input)).toContain('BIFROST_VK=<redacted>');
  });

  it('redacts BIFROST_API_KEY', () => {
    const input = ['-e', 'BIFROST_API_KEY=apikey-secret'];
    expect(redactSecretEnvArgs(input)).toContain('BIFROST_API_KEY=<redacted>');
  });

  it('redacts one-token form: "-e=KEY=value"', () => {
    const input = ['-e=OPENAI_API_KEY=sk-openai-secret'];
    expect(redactSecretEnvArgs(input)).toEqual([
      '-e=OPENAI_API_KEY=<redacted>',
    ]);
  });

  it('passes through non-sensitive env vars unchanged', () => {
    const input = ['-e', 'TIMEZONE=America/Los_Angeles', '-e', 'PORT=3000'];
    expect(redactSecretEnvArgs(input)).toEqual(input);
  });

  it('passes through args with no -e flags unchanged', () => {
    const input = ['docker', 'run', '--rm', 'image:latest', 'bash'];
    expect(redactSecretEnvArgs(input)).toEqual(input);
  });

  it('does not mutate the original array', () => {
    const input = ['-e', 'ANTHROPIC_API_KEY=sk-ant-secret'];
    const copy = [...input];
    redactSecretEnvArgs(input);
    expect(input).toEqual(copy);
  });

  it('handles multiple sensitive flags in sequence', () => {
    const input = [
      '-e',
      'ANTHROPIC_API_KEY=key1',
      '-e',
      'OPENAI_API_KEY=key2',
      '-e',
      'HOST=localhost',
    ];
    const result = redactSecretEnvArgs(input);
    expect(result).toEqual([
      '-e',
      'ANTHROPIC_API_KEY=<redacted>',
      '-e',
      'OPENAI_API_KEY=<redacted>',
      '-e',
      'HOST=localhost',
    ]);
  });

  it('handles empty array', () => {
    expect(redactSecretEnvArgs([])).toEqual([]);
  });

  it('handles lone -e at end of array (no following value)', () => {
    // Malformed input — should not throw, just pass through
    const input = ['docker', 'run', '-e'];
    const result = redactSecretEnvArgs(input);
    expect(result).toEqual(['docker', 'run', '-e']);
  });

  it('covers all SENSITIVE_KEYS', () => {
    for (const key of SENSITIVE_KEYS) {
      const input = ['-e', `${key}=secret-value`];
      const result = redactSecretEnvArgs(input);
      expect(result[1]).toBe(`${key}=<redacted>`);
    }
  });
});

// ─── redactInString ───────────────────────────────────────────────────────────

describe('redactInString', () => {
  it('redacts inline KEY=value in a command string', () => {
    const str =
      'docker run -e ANTHROPIC_API_KEY=sk-ant-abc123 --rm image:latest';
    const result = redactInString(str);
    expect(result).toBe(
      'docker run -e ANTHROPIC_API_KEY=<redacted> --rm image:latest',
    );
  });

  it('redacts CLAUDE_CODE_OAUTH_TOKEN in inline string', () => {
    const str =
      'docker run -e CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xyz --rm image';
    expect(redactInString(str)).toContain('CLAUDE_CODE_OAUTH_TOKEN=<redacted>');
    expect(redactInString(str)).not.toContain('sk-ant-oat01-xyz');
  });

  it('redacts BIFROST_VK in inline string', () => {
    const str = '-e BIFROST_VK=vk-super-secret end';
    expect(redactInString(str)).toBe('-e BIFROST_VK=<redacted> end');
  });

  it('redacts multiple occurrences in a single string', () => {
    const str =
      '-e ANTHROPIC_API_KEY=key1 -e OPENAI_API_KEY=key2 -e HOST=localhost';
    const result = redactInString(str);
    expect(result).toBe(
      '-e ANTHROPIC_API_KEY=<redacted> -e OPENAI_API_KEY=<redacted> -e HOST=localhost',
    );
  });

  it('leaves non-sensitive values unchanged', () => {
    const str = '-e TIMEZONE=UTC -e PORT=3000';
    expect(redactInString(str)).toBe(str);
  });

  it('handles empty string', () => {
    expect(redactInString('')).toBe('');
  });

  it('handles value at end-of-string (no trailing space)', () => {
    const str = '-e DELEGATE_AGENT_TOKEN=tok-secret';
    expect(redactInString(str)).toBe('-e DELEGATE_AGENT_TOKEN=<redacted>');
  });

  it('does not throw on any input', () => {
    expect(() => redactInString('random string')).not.toThrow();
    expect(() => redactInString('=====\x00null')).not.toThrow();
  });

  it('covers all SENSITIVE_KEYS', () => {
    for (const key of SENSITIVE_KEYS) {
      const str = `-e ${key}=secret-value rest`;
      const result = redactInString(str);
      expect(result).toContain(`${key}=<redacted>`);
      expect(result).not.toContain('secret-value');
    }
  });
});
