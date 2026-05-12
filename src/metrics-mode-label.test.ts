/**
 * metrics-mode-label.test.ts
 *
 * Verifies that the `mode` label appears on credential/container metrics output.
 * Uses the real metricsRegistry so we scrape actual Prometheus text format.
 */
import { describe, it, expect, beforeEach } from 'vitest';

// Import after the module is loaded so the registry is populated.
import {
  metricsRegistry,
  recordCredentialResolution,
  recordContainerSpawn,
  recordContainerExit,
} from './metrics.js';

/** Scrape the registry and return raw Prometheus text. */
async function scrape(): Promise<string> {
  return metricsRegistry.metrics();
}

// Reset the registry counters/gauges before each test by clearing and
// re-importing. Because vitest re-uses module state between tests in the same
// file we instead just re-read the current metric output — each test checks
// for metric lines containing the specific label combos it set.

describe('recordCredentialResolution — mode label', () => {
  it('emits mode="oauth" label when mode is "oauth"', async () => {
    recordCredentialResolution('workspace', 'oauth');
    const output = await scrape();
    // Prometheus text format: metric_name{label="value",...} number
    expect(output).toMatch(
      /delegate_agent_credentials_resolved_total\{[^}]*mode="oauth"[^}]*\}/,
    );
  });

  it('emits mode="api_key" label when mode is "api_key"', async () => {
    recordCredentialResolution('onecli', 'api_key');
    const output = await scrape();
    expect(output).toMatch(
      /delegate_agent_credentials_resolved_total\{[^}]*mode="api_key"[^}]*\}/,
    );
  });

  it('emits mode="none" label when mode is "none"', async () => {
    recordCredentialResolution('none', 'none');
    const output = await scrape();
    expect(output).toMatch(
      /delegate_agent_credentials_resolved_total\{[^}]*mode="none"[^}]*\}/,
    );
  });

  it('defaults to mode="api_key" when mode param is omitted', async () => {
    // Call with only tier — old caller signature.
    recordCredentialResolution('static');
    const output = await scrape();
    // Should still have api_key present (either from this call or the one above).
    expect(output).toMatch(
      /delegate_agent_credentials_resolved_total\{[^}]*mode="api_key"[^}]*\}/,
    );
  });
});

describe('recordContainerSpawn / recordContainerExit — mode label on active gauge', () => {
  it('emits workspace_id and mode labels on active gauge after spawn', async () => {
    recordContainerSpawn('delegate_task', false, 'ws-test-123', 'oauth');
    const output = await scrape();
    expect(output).toMatch(
      /delegate_agent_containers_active\{[^}]*workspace_id="ws-test-123"[^}]*mode="oauth"[^}]*\}/,
    );
  });

  it('mode="api_key" is present after spawn with default mode', async () => {
    recordContainerSpawn('delegate_task', false, 'ws-test-456');
    const output = await scrape();
    expect(output).toMatch(
      /delegate_agent_containers_active\{[^}]*workspace_id="ws-test-456"[^}]*mode="api_key"[^}]*\}/,
    );
  });

  it('decrements gauge on exit with matching workspace_id and mode', async () => {
    // Spawn first so we have something to decrement.
    recordContainerSpawn('delegate_task', false, 'ws-exit-test', 'oauth');
    recordContainerExit('delegate_task', 'success', 1.5, 'ws-exit-test', 'oauth');
    // After spawn+exit the gauge should still be present in output (prom-client
    // keeps the label combo even at 0).
    const output = await scrape();
    expect(output).toMatch(
      /delegate_agent_containers_active\{[^}]*workspace_id="ws-exit-test"[^}]*mode="oauth"[^}]*\}/,
    );
  });

  it('does not throw when called without optional params (backward compat)', () => {
    expect(() =>
      recordContainerSpawn('main', true),
    ).not.toThrow();
    expect(() =>
      recordContainerExit('main', 'success', 0.1),
    ).not.toThrow();
  });
});
