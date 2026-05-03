import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { logger } from './logger.js';

// The logger checks process.env.LOG_FORMAT at call time (not module load),
// so we can override per-test via process.env.
//
// Capture strategy: directly swap process.stdout.write / process.stderr.write
// for the duration of fn() so we only capture our own output (not Vitest's).

/* eslint-disable @typescript-eslint/no-explicit-any */
type WriteFn = typeof process.stdout.write;

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const orig: WriteFn = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (chunk: unknown) => { chunks.push(String(chunk)); return true; };
  try { fn(); } finally { (process.stdout as any).write = orig; }
  return chunks.join('');
}

function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const orig: WriteFn = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (chunk: unknown) => { chunks.push(String(chunk)); return true; };
  try { fn(); } finally { (process.stderr as any).write = orig; }
  return chunks.join('');
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('logger — JSON mode (LOG_FORMAT=json)', () => {
  beforeEach(() => {
    process.env.LOG_FORMAT = 'json';
  });

  afterEach(() => {
    delete process.env.LOG_FORMAT;
  });

  it('emits valid JSON with ts, level, msg on stdout for info', () => {
    const out = captureStdout(() => logger.info('hello world'));
    const trimmed = out.trim();
    expect(() => JSON.parse(trimmed)).not.toThrow();
    const obj = JSON.parse(trimmed);
    expect(obj.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601
    expect(obj.level).toBe('info');
    expect(obj.msg).toBe('hello world');
  });

  it('emits valid JSON on stderr for warn', () => {
    const out = captureStderr(() => logger.warn('something bad'));
    const obj = JSON.parse(out.trim());
    expect(obj.level).toBe('warn');
    expect(obj.msg).toBe('something bad');
  });

  it('emits valid JSON on stderr for error', () => {
    const out = captureStderr(() => logger.error('an error occurred'));
    const obj = JSON.parse(out.trim());
    expect(obj.level).toBe('error');
  });

  it('includes context object when data fields are passed', () => {
    const out = captureStdout(() =>
      logger.info({ groupFolder: 'main', taskId: 'abc' }, 'Task started'),
    );
    const obj = JSON.parse(out.trim());
    expect(obj.msg).toBe('Task started');
    expect(obj.context).toBeDefined();
    expect(obj.context.groupFolder).toBe('main');
    expect(obj.context.taskId).toBe('abc');
  });

  it('serializes Error under context.err as { type, message, stack }', () => {
    const err = new TypeError('bad input');
    const out = captureStderr(() => logger.error({ err }, 'Failed'));
    const obj = JSON.parse(out.trim());
    expect(obj.context.err.type).toBe('TypeError');
    expect(obj.context.err.message).toBe('bad input');
    expect(obj.context.err.stack).toBeDefined();
  });

  it('emits one line per call (no embedded newlines in the JSON payload)', () => {
    const out = captureStdout(() => logger.info({ key: 'val' }, 'multi test'));
    const lines = out.split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
  });

  it('omits context key when no data fields are provided', () => {
    const out = captureStdout(() => logger.info('bare message'));
    const obj = JSON.parse(out.trim());
    expect(obj.context).toBeUndefined();
  });
});

describe('logger — pretty mode (LOG_FORMAT unset)', () => {
  beforeEach(() => {
    delete process.env.LOG_FORMAT;
  });

  it('output is NOT valid JSON (human-readable format)', () => {
    const out = captureStdout(() => logger.info('hello pretty'));
    expect(() => JSON.parse(out.trim())).toThrow();
  });

  it('output contains the message text', () => {
    const out = captureStdout(() => logger.info('readable output check'));
    expect(out).toContain('readable output check');
  });
});
