import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, expect, it, vi } from 'vitest';

import { followPullEvents } from './events.js';
import { STATE_DIR } from './lib.js';

const { gh, spawn, loadState, pause } = vi.hoisted(() => ({
  gh: vi.fn(),
  spawn: vi.fn(),
  loadState: vi.fn(),
  pause: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: gh }), spawn };
});

vi.mock('node:timers/promises', () => ({ setTimeout: pause }));

vi.mock('./lib.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./lib.js')>(),
  loadState,
  STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-events-')),
}));

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
});

it('keeps at most 40 subscriptions and deletes a departed PR before filling its slot', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const tracked = Object.fromEntries(Array.from({ length: 41 }, (_, index) => [`owner/repo#${index + 1}`, {}]));
  loadState.mockReturnValue(tracked);
  spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    return Object.assign(child, { kill: () => child.emit('close') });
  });
  const operations: string[] = [];
  gh.mockImplementation(async (_executable, args: string[]) => {
    if (args[2] === 'create') {
      const number = args[args.indexOf('--resource') + 1].split('/').at(-1);
      operations.push(`create ${number}`);
      return { stdout: JSON.stringify({ id: `sub-${number}`, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }) };
    }
    operations.push(`delete ${args.at(-1)?.split('/').at(-1)}`);
    return { stdout: '' };
  });

  let resume: (() => void) | undefined;
  pause.mockImplementation(() => new Promise<void>((resolve) => { resume = resolve; }));
  const stop = new AbortController();
  const listener = followPullEvents(async () => true, stop.signal);
  try {
    await vi.waitFor(() => expect(pause).toHaveBeenCalledTimes(1));
    expect(operations).toHaveLength(40);
    expect(operations).toContain('create 1');
    expect(operations).not.toContain('create 41');

    delete tracked['owner/repo#1'];
    resume?.();
    await vi.waitFor(() => expect(pause).toHaveBeenCalledTimes(2));
    expect(operations.slice(40)).toEqual(['delete sub-1', 'create 41']);
  } finally {
    stop.abort();
    resume?.();
    await listener;
  }
});
