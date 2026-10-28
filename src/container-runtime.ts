/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execFile, execSync, spawn } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';
import { getDefaultContainerImage } from './install-slug.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
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
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}

const execFileAsync = promisify(execFile);
const imageChecks = new Map<string, Promise<void>>();
const imageRetryAfter = new Map<string, number>();
const IMAGE_RECOVERY_BACKOFF_MS = 15 * 60 * 1000;

export function ensureContainerImage(image: string): Promise<void> {
  const existing = imageChecks.get(image);
  if (existing) return existing;
  const inspect = () =>
    execFileAsync(CONTAINER_RUNTIME_BIN, ['image', 'inspect', image, '--format', '{{.Id}}'], { timeout: 10000 });
  const check = (async () => {
    try {
      await inspect();
      imageRetryAfter.delete(image);
      return;
    } catch {
      if (image !== getDefaultContainerImage(process.cwd())) {
        throw new Error(
          `Agent image unavailable: ${image}. Restore this exact image before retrying; queues are preserved.`,
        );
      }
    }
    const retryAfter = imageRetryAfter.get(image) ?? 0;
    if (Date.now() < retryAfter) {
      throw new Error(
        `Agent image unavailable: ${image}; retry after ${new Date(retryAfter).toISOString()}. Run ./container/build.sh to restore it now; queues are preserved.`,
      );
    }
    imageRetryAfter.set(image, Date.now() + IMAGE_RECOVERY_BACKOFF_MS);
    log.warn('Agent image unavailable; recovering through container/build.sh', { image });
    try {
      await new Promise<void>((resolve, reject) => {
        const build = spawn('bash', [path.resolve('container/build.sh')], {
          cwd: process.cwd(),
          detached: true,
          stdio: 'ignore',
        });
        const timeout = setTimeout(
          () => {
            if (build.pid) {
              try {
                process.kill(-build.pid, 'SIGKILL');
              } catch {}
            }
            reject(new Error('Agent image build timed out'));
          },
          20 * 60 * 1000,
        );
        build.once('error', () => {
          clearTimeout(timeout);
          reject(new Error('Agent image build could not start'));
        });
        build.once('exit', (code) => {
          clearTimeout(timeout);
          if (code === 0) resolve();
          else reject(new Error('Agent image build failed'));
        });
      });
      await inspect();
      imageRetryAfter.delete(image);
      log.info('Agent image recovered', { image });
    } catch {
      const retryAt = Date.now() + IMAGE_RECOVERY_BACKOFF_MS;
      imageRetryAfter.set(image, retryAt);
      throw new Error(
        `Agent image recovery failed: ${image}; retry after ${new Date(retryAt).toISOString()}. Check Docker and run ./container/build.sh; queues are preserved.`,
      );
    }
  })().finally(() => imageChecks.delete(image));
  imageChecks.set(image, check);
  return check;
}
