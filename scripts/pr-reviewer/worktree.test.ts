import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve('templates/pr-reviewer/skills/pr-worktree/bin/worktree.sh');
const OWNER_REPLY = path.resolve('scripts/pr-reviewer/owner-reply.ts');
const SKILL = path.resolve('templates/pr-reviewer/skills/pr-worktree/SKILL.md');

let root: string;
let seed: string;
let bare: string;
let bin: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-worktree-'));
  bin = path.join(root, 'bin');
  seed = path.join(root, 'seed');
  bare = path.join(root, 'repos', 'acme__widgets', 'git');
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
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REPOS_ROOT: path.join(root, 'repos') },
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
    expect(output).toContain(`WT=${path.join(root, 'repos', 'acme__widgets', 'wt', 'pr-7')}`);
    expect(run(['--git-dir', admin, 'rev-parse', 'HEAD'])).toBe(next);
    expect(fs.existsSync(path.join(admin, 'index.lock'))).toBe(false);
  });

  it('prepares an owner reply with the current GitHub head and delta from the previous review', () => {
    const previous = run(['-C', seed, 'rev-parse', 'HEAD']);
    const current = commit('two');
    run(['-C', seed, 'update-ref', 'refs/pull/7/head', current]);
    run(['-C', seed, 'update-ref', 'refs/heads/base', previous]);
    run(['-C', bare, 'remote', 'add', 'origin', seed]);

    const stateDir = path.join(root, 'data', 'pr-reviewer');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({ 'acme/widgets#7': { head_sha: previous } }));
    fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
    const detail = JSON.stringify({ number: 7, head: { sha: current }, base: { ref: 'base' } });
    fs.writeFileSync(
      path.join(bin, 'gh'),
      `#!/bin/sh\ncase "$2" in\nrepos/acme/widgets/pulls/7) printf '%s' '${detail}' ;;\ngraphql) printf '%s' '{}' ;;\n*) exit 1 ;;\nesac\n`,
      { mode: 0o755 },
    );

    const output = execFileSync(process.execPath, ['--import', 'tsx', OWNER_REPLY, 'acme/widgets#7', 'owner_reply:7'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PR_SELF_LOGIN: 'reviewer' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const { headSha, text } = JSON.parse(output);
    expect(headSha).toBe(current);
    expect(text).toContain(`head sha: ${current}`);
    expect(text).toContain(`Previous reviewed head: ${previous}`);
    expect(text).toContain('M\tfile.txt');
    expect(run(['-C', bare, 'rev-parse', 'refs/pr/7/head'])).toBe(current);
  });
});
