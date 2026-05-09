/**
 * Container runtime abstraction for DelegateAgent.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import os from 'os';

import { logger } from './logger.js';

/**
 * Resolve the container runtime binary.
 *
 * Selection order:
 *   1. `DELEGATE_CONTAINER_RUNTIME` env var (explicit override).
 *   2. On macOS: `container` (Apple Container) if installed and `docker` is not.
 *   3. `docker` (Linux primary, macOS default when Docker Desktop is running).
 *
 * NOTE: Apple Container uses a different mount syntax (`--mount
 * type=bind,...`) than Docker (`-v src:dst:ro`). Setting the binary name to
 * `container` is necessary but NOT sufficient — run the
 * `/convert-to-apple-container` skill to migrate the rest of the runtime
 * code. Until then, override via env var only when the migration is done.
 */
function detectRuntimeBin(): string {
  const override = process.env.DELEGATE_CONTAINER_RUNTIME?.trim();
  if (override) return override;

  if (os.platform() === 'darwin') {
    const haveDocker = canRun('docker');
    const haveAppleContainer = canRun('container');
    // Prefer Apple Container only when Docker isn't available — keeps the
    // default unchanged for the common Docker Desktop case but lets a
    // Docker-free Mac dev box pick up Apple Container automatically.
    if (haveAppleContainer && !haveDocker) return 'container';
  }

  return 'docker';
}

function canRun(bin: string): boolean {
  try {
    execSync(`${bin} --version`, { stdio: 'pipe', timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = detectRuntimeBin();

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      `║  1. Ensure ${CONTAINER_RUNTIME_BIN} is installed and running                     ║`.slice(
        0,
        67,
      ) + '║',
    );
    console.error(
      `║  2. Run: ${CONTAINER_RUNTIME_BIN} info                                           ║`.slice(
        0,
        67,
      ) + '║',
    );
    console.error(
      '║  3. macOS: try Apple Container — run /convert-to-apple-       ║',
    );
    console.error(
      '║     container to switch runtimes natively                      ║',
    );
    console.error(
      '║  4. Restart DelegateAgent                                      ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/** Kill orphaned DelegateAgent containers from previous runs.
 * Matches both `delegate-agent-` (current) and `nanoclaw-` (legacy) prefixes
 * to clean up stragglers from pre-rebrand deployments.
 */
export function cleanupOrphans(): void {
  try {
    const currentOut = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=delegate-agent- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const legacyOut = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const names = [
      ...currentOut.trim().split('\n').filter(Boolean),
      // Rewrite legacy prefix names for logging consistency — the actual
      // stopContainer call uses the original name from docker ps.
      ...legacyOut
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((n) => n.replace(/^nanoclaw-/, 'delegate-agent-')),
    ];
    const rawNames = [
      ...currentOut.trim().split('\n').filter(Boolean),
      ...legacyOut.trim().split('\n').filter(Boolean),
    ];
    for (const raw of rawNames) {
      try {
        stopContainer(raw);
      } catch {
        /* already stopped */
      }
    }
    if (names.length > 0) {
      logger.info(
        { count: names.length, names },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
