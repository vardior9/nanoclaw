import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock log
vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
const mockExecFile = vi.fn();
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFile: (...args: unknown[]) => mockExecFile(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('calls docker stop for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-test-123`, {
      stdio: 'pipe',
    });
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow('Invalid container name');
    expect(() => stopContainer('foo$(whoami)')).toThrow('Invalid container name');
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(log.debug).toHaveBeenCalledWith('Container runtime already running');
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow('Container runtime is required but failed to start');
    expect(log.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('filters ps by the install label so peers are not reaped', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      expect.any(Object),
    );
  });

  it('stops orphaned nanoclaw containers', () => {
    // docker ps returns container names, one per line
    mockExecSync.mockReturnValueOnce('nanoclaw-group1-111\nnanoclaw-group2-222\n');
    // stop calls succeed
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ps + 2 stop calls
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group1-111`, {
      stdio: 'pipe',
    });
    expect(mockExecSync).toHaveBeenNthCalledWith(3, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group2-222`, {
      stdio: 'pipe',
    });
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'],
    });
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(log.warn).toHaveBeenCalledWith(
      'Failed to clean up orphaned containers',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    // First stop fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-a-1', 'nanoclaw-b-2'],
    });
  });
});

describe('missing image recovery', () => {
  it('shares a failed rebuild, backs off, and notices an externally restored image', async () => {
    vi.resetModules();
    const { ensureContainerImage } = await import('./container-runtime.js');
    const { CONTAINER_IMAGE } = await import('./config.js');
    let restored = false;
    let rebuilds = 0;
    mockExecFile.mockImplementation((binary, args, options, callback) => {
      callback(restored ? null : new Error('missing image'), '', '');
    });
    mockSpawn.mockImplementation(() => {
      rebuilds++;
      const build = new EventEmitter();
      setTimeout(() => build.emit('error', new Error('private build output')), 0);
      return build;
    });
    const attempts = await Promise.allSettled([
      ensureContainerImage(CONTAINER_IMAGE),
      ensureContainerImage(CONTAINER_IMAGE),
    ]);
    expect(attempts.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    await expect(ensureContainerImage(CONTAINER_IMAGE)).rejects.toThrow('retry after');
    expect(rebuilds).toBe(1);
    const errors = attempts.flatMap((result) => (result.status === 'rejected' ? [result.reason.message] : []));
    expect(errors).toHaveLength(2);
    expect(errors.every((message) => message.includes('Agent image recovery failed'))).toBe(true);
    expect(errors.join(' ')).not.toContain('private build output');
    restored = true;
    await expect(ensureContainerImage(CONTAINER_IMAGE)).resolves.toBeUndefined();
    expect(rebuilds).toBe(1);
  });

  it('bounds a stuck rebuild and kills only its process group', async () => {
    vi.resetModules();
    const { ensureContainerImage } = await import('./container-runtime.js');
    const { CONTAINER_IMAGE } = await import('./config.js');
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      mockExecFile.mockImplementation((binary, args, options, callback) => callback(new Error('missing'), '', ''));
      mockSpawn.mockReturnValue(Object.assign(new EventEmitter(), { pid: 43210 }));
      const failure = expect(ensureContainerImage(CONTAINER_IMAGE)).rejects.toThrow('Agent image recovery failed');
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      await failure;
      expect(kill).toHaveBeenCalledExactlyOnceWith(-43210, 'SIGKILL');
      await expect(ensureContainerImage(CONTAINER_IMAGE)).rejects.toThrow('retry after');
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  it('fails before launching or rebuilding a missing custom image', async () => {
    const { ensureContainerImage } = await import('./container-runtime.js');
    mockExecFile.mockImplementation((binary, args, options, callback) => callback(new Error('missing'), '', ''));
    await expect(ensureContainerImage('synthetic-reviewer:missing')).rejects.toThrow('Restore this exact image');
    expect(mockExecFile.mock.calls.every(([binary]) => binary === 'docker')).toBe(true);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
