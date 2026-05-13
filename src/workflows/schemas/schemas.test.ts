import { describe, expect, it } from 'vitest';

import {
  ALLOWED_PROVIDERS,
  dagNodeSchema,
  loopNodeConfigSchema,
  stepRetryConfigSchema,
  workflowDefinitionSchema,
  workflowRunStatusSchema,
  TERMINAL_WORKFLOW_STATUSES,
  RESUMABLE_WORKFLOW_STATUSES,
  TRIGGER_RULES,
  isApprovalContext,
  isBashNode,
  isLoopNode,
  isApprovalNode,
  isCancelNode,
  isScriptNode,
  isTriggerRule,
} from './index.js';

// ─── retry ──────────────────────────────────────────────────────────────────

describe('stepRetryConfigSchema', () => {
  it('accepts minimal valid config', () => {
    expect(stepRetryConfigSchema.safeParse({ max_attempts: 3 }).success).toBe(
      true,
    );
  });

  it('rejects max_attempts > 5', () => {
    const r = stepRetryConfigSchema.safeParse({ max_attempts: 6 });
    expect(r.success).toBe(false);
  });

  it('rejects delay_ms < 1000', () => {
    const r = stepRetryConfigSchema.safeParse({
      max_attempts: 2,
      delay_ms: 999,
    });
    expect(r.success).toBe(false);
  });

  it('accepts on_error values', () => {
    expect(
      stepRetryConfigSchema.safeParse({
        max_attempts: 2,
        on_error: 'transient',
      }).success,
    ).toBe(true);
    expect(
      stepRetryConfigSchema.safeParse({ max_attempts: 2, on_error: 'all' })
        .success,
    ).toBe(true);
    expect(
      stepRetryConfigSchema.safeParse({
        max_attempts: 2,
        on_error: 'fatal' as never,
      }).success,
    ).toBe(false);
  });
});

// ─── loop ───────────────────────────────────────────────────────────────────

describe('loopNodeConfigSchema', () => {
  it('accepts minimal valid loop', () => {
    const r = loopNodeConfigSchema.safeParse({
      prompt: 'iterate',
      until: 'DONE',
      max_iterations: 3,
    });
    expect(r.success).toBe(true);
  });

  it('caps max_iterations at 50 per plan R6', () => {
    const r = loopNodeConfigSchema.safeParse({
      prompt: 'iterate',
      until: 'DONE',
      max_iterations: 51,
    });
    expect(r.success).toBe(false);
  });

  it('rejects interactive without gate_message', () => {
    const r = loopNodeConfigSchema.safeParse({
      prompt: 'iterate',
      until: 'DONE',
      max_iterations: 3,
      interactive: true,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toMatch(/gate_message/);
    }
  });

  it('accepts interactive with gate_message', () => {
    const r = loopNodeConfigSchema.safeParse({
      prompt: 'iterate',
      until: 'DONE',
      max_iterations: 3,
      interactive: true,
      gate_message: 'Approve sprint?',
    });
    expect(r.success).toBe(true);
  });

  it('defaults fresh_context to false', () => {
    const r = loopNodeConfigSchema.parse({
      prompt: 'iterate',
      until: 'DONE',
      max_iterations: 3,
    });
    expect(r.fresh_context).toBe(false);
  });
});

// ─── workflow run state constants ──────────────────────────────────────────

describe('workflow run status constants', () => {
  it('TERMINAL covers completed/failed/cancelled', () => {
    expect([...TERMINAL_WORKFLOW_STATUSES].sort()).toEqual([
      'cancelled',
      'completed',
      'failed',
    ]);
  });

  it('RESUMABLE covers failed/paused', () => {
    expect([...RESUMABLE_WORKFLOW_STATUSES].sort()).toEqual([
      'failed',
      'paused',
    ]);
  });

  it('schema accepts all six statuses', () => {
    for (const s of [
      'pending',
      'running',
      'completed',
      'failed',
      'cancelled',
      'paused',
    ]) {
      expect(workflowRunStatusSchema.safeParse(s).success).toBe(true);
    }
  });

  it('schema rejects unknown statuses', () => {
    expect(workflowRunStatusSchema.safeParse('blocked').success).toBe(false);
  });
});

// ─── isApprovalContext ──────────────────────────────────────────────────────

describe('isApprovalContext', () => {
  it('returns true for minimal valid', () => {
    expect(isApprovalContext({ nodeId: 'approve', message: 'ok?' })).toBe(true);
  });

  it('returns false when missing nodeId', () => {
    expect(isApprovalContext({ message: 'ok?' })).toBe(false);
  });

  it('returns false for null/non-object', () => {
    expect(isApprovalContext(null)).toBe(false);
    expect(isApprovalContext('string')).toBe(false);
    expect(isApprovalContext(42)).toBe(false);
  });
});

// ─── trigger rules ──────────────────────────────────────────────────────────

describe('TRIGGER_RULES + isTriggerRule', () => {
  it('contains exactly the four canonical rules', () => {
    expect([...TRIGGER_RULES].sort()).toEqual([
      'all_done',
      'all_success',
      'none_failed_min_one_success',
      'one_success',
    ]);
  });

  it('isTriggerRule guards', () => {
    expect(isTriggerRule('all_success')).toBe(true);
    expect(isTriggerRule('bogus')).toBe(false);
    expect(isTriggerRule(42)).toBe(false);
  });
});

// ─── dagNodeSchema mutual exclusivity ──────────────────────────────────────

describe('dagNodeSchema — mutual exclusivity', () => {
  it('accepts a prompt-only node', () => {
    const r = dagNodeSchema.safeParse({ id: 'a', prompt: 'hello' });
    expect(r.success).toBe(true);
    if (r.success) expect(isBashNode(r.data)).toBe(false);
  });

  it('accepts a bash-only node', () => {
    const r = dagNodeSchema.safeParse({ id: 'a', bash: "echo 'hi'" });
    expect(r.success).toBe(true);
    if (r.success) expect(isBashNode(r.data)).toBe(true);
  });

  it('rejects prompt + bash together', () => {
    const r = dagNodeSchema.safeParse({ id: 'a', prompt: 'x', bash: 'echo' });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues[0]?.message).toMatch(/mutually exclusive/);
  });

  it('rejects node with no mode field', () => {
    const r = dagNodeSchema.safeParse({ id: 'a' });
    expect(r.success).toBe(false);
  });

  it('rejects empty id', () => {
    const r = dagNodeSchema.safeParse({ id: '', prompt: 'x' });
    expect(r.success).toBe(false);
  });
});

describe('dagNodeSchema — provider allowlist', () => {
  it('accepts provider: claude', () => {
    const r = dagNodeSchema.safeParse({
      id: 'a',
      prompt: 'x',
      provider: 'claude',
    });
    expect(r.success).toBe(true);
  });

  it('accepts provider: nanoclaw', () => {
    const r = dagNodeSchema.safeParse({
      id: 'a',
      prompt: 'x',
      provider: 'nanoclaw',
    });
    expect(r.success).toBe(true);
  });

  it('rejects provider: gpt-5 with explicit runbook message', () => {
    const r = dagNodeSchema.safeParse({
      id: 'a',
      prompt: 'x',
      provider: 'gpt-5',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toMatch(
        /Bifrost VK config — see runbook/,
      );
      expect(r.error.issues[0]?.message).toMatch(/claude, nanoclaw/);
    }
  });

  it('rejects provider: gemini', () => {
    const r = dagNodeSchema.safeParse({
      id: 'a',
      prompt: 'x',
      provider: 'gemini',
    });
    expect(r.success).toBe(false);
  });

  it('ALLOWED_PROVIDERS list is canonical', () => {
    expect([...ALLOWED_PROVIDERS].sort()).toEqual(['claude', 'nanoclaw']);
  });
});

describe('dagNodeSchema — script node', () => {
  it('requires runtime when script: is set', () => {
    const r = dagNodeSchema.safeParse({ id: 's', script: 'console.log(1)' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/runtime/);
  });

  it('accepts script + runtime: bun', () => {
    const r = dagNodeSchema.safeParse({
      id: 's',
      script: 'console.log(1)',
      runtime: 'bun',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(isScriptNode(r.data)).toBe(true);
  });

  it('accepts script + runtime: uv + deps', () => {
    const r = dagNodeSchema.safeParse({
      id: 's',
      script: 'print(1)',
      runtime: 'uv',
      deps: ['requests'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects negative timeout', () => {
    const r = dagNodeSchema.safeParse({
      id: 's',
      script: 'x',
      runtime: 'bun',
      timeout: -1,
    });
    expect(r.success).toBe(false);
  });
});

describe('dagNodeSchema — loop node', () => {
  it('accepts a loop node', () => {
    const r = dagNodeSchema.safeParse({
      id: 'l',
      loop: { prompt: 'iterate', until: 'DONE', max_iterations: 3 },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(isLoopNode(r.data)).toBe(true);
  });

  it('rejects retry on loop nodes', () => {
    const r = dagNodeSchema.safeParse({
      id: 'l',
      loop: { prompt: 'iterate', until: 'DONE', max_iterations: 3 },
      retry: { max_attempts: 2 },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/retry/);
  });
});

describe('dagNodeSchema — approval + cancel nodes', () => {
  it('accepts approval', () => {
    const r = dagNodeSchema.safeParse({
      id: 'a',
      approval: { message: 'Approve?' },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(isApprovalNode(r.data)).toBe(true);
  });

  it('rejects approval with empty message', () => {
    const r = dagNodeSchema.safeParse({
      id: 'a',
      approval: { message: '' },
    });
    expect(r.success).toBe(false);
  });

  it('accepts cancel', () => {
    const r = dagNodeSchema.safeParse({ id: 'c', cancel: 'aborted' });
    expect(r.success).toBe(true);
    if (r.success) expect(isCancelNode(r.data)).toBe(true);
  });
});

describe('dagNodeSchema — bash node', () => {
  it('accepts bash + timeout', () => {
    const r = dagNodeSchema.safeParse({
      id: 'b',
      bash: 'echo hi',
      timeout: 5000,
    });
    expect(r.success).toBe(true);
  });

  it('rejects timeout <= 0', () => {
    const r = dagNodeSchema.safeParse({ id: 'b', bash: 'echo hi', timeout: 0 });
    expect(r.success).toBe(false);
  });

  it('rejects idle_timeout = -1', () => {
    const r = dagNodeSchema.safeParse({
      id: 'b',
      bash: 'echo hi',
      idle_timeout: -1,
    });
    expect(r.success).toBe(false);
  });
});

// ─── workflowDefinitionSchema ───────────────────────────────────────────────

describe('workflowDefinitionSchema', () => {
  it('accepts a minimal two-node DAG', () => {
    const r = workflowDefinitionSchema.safeParse({
      name: 'demo',
      description: 'demo workflow',
      nodes: [
        { id: 'a', prompt: 'hello' },
        { id: 'b', depends_on: ['a'], bash: 'echo done' },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.nodes.length).toBe(2);
      expect(r.data.nodes[1].depends_on).toEqual(['a']);
    }
  });

  it('rejects workflow-level provider gpt-5', () => {
    const r = workflowDefinitionSchema.safeParse({
      name: 'demo',
      description: 'd',
      provider: 'gpt-5',
      nodes: [{ id: 'a', prompt: 'x' }],
    });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues[0]?.message).toMatch(/Bifrost VK config/);
  });

  it('accepts workflow-level provider claude', () => {
    const r = workflowDefinitionSchema.safeParse({
      name: 'demo',
      description: 'd',
      provider: 'claude',
      nodes: [{ id: 'a', prompt: 'x' }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty name', () => {
    const r = workflowDefinitionSchema.safeParse({
      name: '',
      description: 'd',
      nodes: [{ id: 'a', prompt: 'x' }],
    });
    expect(r.success).toBe(false);
  });
});
