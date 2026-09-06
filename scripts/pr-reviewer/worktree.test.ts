import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve('templates/pr-reviewer/skills/pr-worktree/bin/worktree.sh');
const SKILL = path.resolve('templates/pr-reviewer/skills/pr-worktree/SKILL.md');

let root: string;
let seed: string;
let bare: string;
let bin: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-worktree-'));
  bin = path.join(root, 'bin');
  seed = path.join(root, 'seed');
  bare = path.join(root, 'acme__widgets', 'git');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  run(['init', '--bare', bare]);
  run(['init', seed]);
  run(['-C', seed, 'config', 'user.email', 'reviewer@example.com']);
  run(['-C', seed, 'config', 'user.name', 'Reviewer Test']);
  commit('one');
  run(['-C', seed, 'push', bare, 'HEAD:refs/pr/7/head']);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function run(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(contents: string): string {
  fs.writeFileSync(path.join(seed, 'file.txt'), contents);
  run(['-C', seed, 'add', 'file.txt']);
  run(['-C', seed, 'commit', '-m', contents]);
  return run(['-C', seed, 'rev-parse', 'HEAD']);
}

function checkout(): string {
  return execFileSync('bash', [SCRIPT, 'acme/widgets', '7'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REPOS_ROOT: root },
  });
}

describe('PR reviewer worktree helper', () => {
  it('uses the skill path that exists in a Codex agent workspace', () => {
    const skill = fs.readFileSync(SKILL, 'utf8');
    expect(skill).toContain('/workspace/agent/.agents/skills/pr-worktree/bin/worktree.sh');
    expect(skill).toContain('wait on that same running command');
  });

  it('recovers a stale index lock and moves an existing worktree to the latest host-fetched head', () => {
    checkout();
    const next = commit('two');
    run(['-C', seed, 'push', '--force', bare, 'HEAD:refs/pr/7/head']);

    const admin = path.join(bare, 'worktrees', 'pr-7');
    fs.writeFileSync(path.join(admin, 'index.lock'), '');

    const output = checkout();
    expect(output).toContain(`WT=${path.join(root, 'acme__widgets', 'wt', 'pr-7')}`);
    expect(run(['--git-dir', admin, 'rev-parse', 'HEAD'])).toBe(next);
    expect(fs.existsSync(path.join(admin, 'index.lock'))).toBe(false);
  });
});
