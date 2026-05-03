/**
 * In-process ring buffer of recent container invocations for the /admin
 * dashboard. Bounded at 50 entries; oldest entries drop off.
 *
 * This module is intentionally standalone — `container-runner.ts` does NOT
 * currently emit hooks for this. Phase 4 (logs partial) is the natural place
 * to wire telemetry recording into the runner. Until then, the containers
 * panel renders an explanatory placeholder when the buffer is empty.
 */

const MAX_ENTRIES = 50;

export interface ContainerTelemetryEntry {
  id: string;
  groupFolder: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: 'running' | 'success' | 'error' | 'timeout';
  exitCode?: number;
  errorMessage?: string;
}

const buffer: ContainerTelemetryEntry[] = [];

export function recordContainerStart(
  id: string,
  groupFolder: string,
): void {
  buffer.push({
    id,
    groupFolder,
    startedAt: new Date().toISOString(),
    status: 'running',
  });
  while (buffer.length > MAX_ENTRIES) buffer.shift();
}

export function recordContainerEnd(
  id: string,
  status: 'success' | 'error' | 'timeout',
  exitCode?: number,
  errorMessage?: string,
): void {
  const entry = buffer.find((e) => e.id === id);
  if (!entry) return;
  entry.endedAt = new Date().toISOString();
  entry.durationMs = Date.parse(entry.endedAt) - Date.parse(entry.startedAt);
  entry.status = status;
  entry.exitCode = exitCode;
  entry.errorMessage = errorMessage;
}

export function getContainerTelemetry(): ContainerTelemetryEntry[] {
  // Return newest first
  return [...buffer].reverse();
}

export function _resetContainerTelemetryForTests(): void {
  buffer.length = 0;
}
