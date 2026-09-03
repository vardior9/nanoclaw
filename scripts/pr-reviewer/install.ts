/**
 * scripts/pr-reviewer/install.ts — one-time, idempotent installer for the
 * PR-reviewer dispatcher.
 *
 * Usage:
 *   pnpm exec tsx scripts/pr-reviewer/install.ts --group <agent_group_id>
 *
 * Does NOT start anything — prints the `launchctl bootstrap` command for
 * the operator to run themselves after reviewing the generated plist.
 *
 * Steps (each idempotent — safe to re-run):
 *   1. Ensure repos/ exists.
 *   2. Verify the mount allowlist grants read-write on repos/ — never edits
 *      that file (it deliberately lives outside operator-writable-by-agent
 *      reach); prints copy/paste instructions and exits non-zero if absent.
 *   3. Merge the repos/ RW mount into the group's container_configs row.
 *   4. Render and write the launchd plist to ~/Library/LaunchAgents/.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getAgentGroup } from '../../src/db/agent-groups.js';
import {
  getContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../../src/db/container-configs.js';
import { initDb, runMigrations } from '../../src/db/index.js';
import type { AdditionalMountConfig } from '../../src/container-config.js';
import { getInstallSlug } from '../../src/install-slug.js';
import { PROJECT_ROOT, REPOS_ROOT } from './lib.js';

function fail(msg: string): never {
  console.error(`pr-reviewer install: ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]): { group: string | null } {
  let group: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--group') group = argv[++i] ?? null;
  }
  return { group };
}

function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function getNodePath(): string {
  try {
    return execSync('command -v node', { encoding: 'utf-8' }).trim();
  } catch {
    return process.execPath;
  }
}

function ensureReposDir(): void {
  fs.mkdirSync(REPOS_ROOT, { recursive: true });
  console.log(`ensured ${REPOS_ROOT}`);
}

/** Verify (never edit) the mount allowlist grants RW on REPOS_ROOT. */
function verifyMountAllowlist(): void {
  const allowlistPath = path.join(os.homedir(), '.config', 'nanoclaw', 'mount-allowlist.json');
  let raw: string;
  try {
    raw = fs.readFileSync(allowlistPath, 'utf-8');
  } catch {
    fail(
      `mount allowlist not found at ${allowlistPath}.\n` +
        `Add this repo's clone root before continuing (see /manage-mounts, or edit the file directly):\n` +
        `  {\n` +
        `    "path": "${REPOS_ROOT}",\n` +
        `    "allowReadWrite": true,\n` +
        `    "description": "pr-reviewer bare clones + worktrees"\n` +
        `  }\n` +
        `merged into the "allowedRoots" array of ${allowlistPath}.`,
    );
  }

  let parsed: { allowedRoots?: Array<{ path?: string; allowReadWrite?: boolean; readOnly?: boolean }> };
  try {
    parsed = JSON.parse(raw!);
  } catch {
    fail(`mount allowlist at ${allowlistPath} is not valid JSON — fix it before continuing.`);
  }

  const roots = Array.isArray(parsed!.allowedRoots) ? parsed!.allowedRoots : [];
  const matches = roots.some((r) => {
    if (typeof r.path !== 'string') return false;
    if (path.resolve(expandTilde(r.path)) !== REPOS_ROOT) return false;
    // Mirror src/modules/mount-security's allowReadWrite/readOnly translation.
    const rw = typeof r.allowReadWrite === 'boolean' ? r.allowReadWrite : r.readOnly === false;
    return rw;
  });

  if (!matches) {
    fail(
      `mount allowlist at ${allowlistPath} has no read-write root covering ${REPOS_ROOT}.\n` +
        `Add this entry to its "allowedRoots" array before continuing:\n` +
        `  {\n` +
        `    "path": "${REPOS_ROOT}",\n` +
        `    "allowReadWrite": true,\n` +
        `    "description": "pr-reviewer bare clones + worktrees"\n` +
        `  }`,
    );
  }
  console.log(`mount allowlist OK — ${REPOS_ROOT} is a read-write root`);
}

/** Merge (never clobber) the repos/ RW mount into the group's container config. */
function installReviewerRuntime(groupId: string): void {
  const dbPath = path.join(PROJECT_ROOT, 'data', 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db);

  const group = getAgentGroup(groupId);
  if (!group) {
    fail(`no agent group with id "${groupId}" — create/wire it first (e.g. via /manage-channels), then re-run.`);
  }
  const row = getContainerConfig(groupId);
  if (!row) {
    fail(
      `no container_configs row for group "${groupId}" — it needs to spawn at least once (or run \`ncl groups config get --id ${groupId}\`) before this can merge a mount.`,
    );
  }

  const existing = JSON.parse(row!.additional_mounts) as AdditionalMountConfig[];
  const mount: AdditionalMountConfig = { hostPath: REPOS_ROOT, containerPath: 'repos', readonly: false };
  const already = existing.some((m) => m.hostPath === mount.hostPath && m.containerPath === mount.containerPath);
  if (already) {
    console.log(`mount already present on group ${groupId}`);
  } else {
    existing.push(mount);
    updateContainerConfigJson(groupId, 'additional_mounts', existing);
    console.log(
      `added mount ${JSON.stringify(mount)} to group ${groupId} (run \`ncl groups restart --id ${groupId}\` to apply)`,
    );
  }

  // Reviewer turns are disposable jobs, not a general assistant conversation.
  // Keep the GitHub gateway skill, omit unrelated runtime skills/instructions,
  // and never hand a prior provider continuation to the next event or task run.
  updateContainerConfigJson(groupId, 'skills', ['onecli-gateway']);
  updateContainerConfigScalars(groupId, {
    continuation_mode: 'fresh',
    context_profile: 'focused',
    cli_scope: 'disabled',
    max_messages_per_prompt: 4,
    turn_timeout_ms: 5 * 60 * 1000,
    max_tool_calls_per_turn: 20,
  });
  console.log(`configured group ${groupId} for fresh, focused reviewer turns`);
}

function installLaunchdPlist(): string {
  const label = `com.nanoclaw.pr-dispatch.${getInstallSlug(PROJECT_ROOT)}`;
  const templatePath = path.join(PROJECT_ROOT, 'launchd', 'com.nanoclaw.pr-dispatch.plist.template');
  const template = fs.readFileSync(templatePath, 'utf-8');

  const logDir = path.join(PROJECT_ROOT, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'pr-dispatch.log');

  const rendered = template
    .replaceAll('{{LABEL}}', label)
    .replaceAll('{{NODE_PATH}}', getNodePath())
    .replaceAll('{{NODE_BIN_DIR}}', path.dirname(getNodePath()))
    .replaceAll('{{TSX_CLI_PATH}}', path.join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'))
    .replaceAll('{{DISPATCH_SCRIPT_PATH}}', path.join(PROJECT_ROOT, 'scripts', 'pr-reviewer', 'dispatch.ts'))
    .replaceAll('{{PROJECT_ROOT}}', PROJECT_ROOT)
    .replaceAll('{{HOME}}', os.homedir())
    .replaceAll('{{LOG_PATH}}', logPath);

  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, rendered);
  console.log(`wrote ${plistPath}`);
  return plistPath;
}

function main(): void {
  const { group } = parseArgs(process.argv.slice(2));
  if (!group) fail('usage: pnpm exec tsx scripts/pr-reviewer/install.ts --group <agent_group_id>');

  ensureReposDir();
  verifyMountAllowlist();
  installReviewerRuntime(group!);
  const plistPath = installLaunchdPlist();

  const uid = typeof process.getuid === 'function' ? process.getuid() : '$(id -u)';
  console.log('\nInstall complete. To load the dispatcher (not run automatically):');
  console.log(`  launchctl bootstrap gui/${uid} ${plistPath}`);
}

main();
