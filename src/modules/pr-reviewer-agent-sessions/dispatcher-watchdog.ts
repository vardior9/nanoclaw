import fs from 'fs';
import path from 'path';

import { DATA_DIR, INSTALL_SLUG } from '../../config.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';

const LAST_TICK_PATH = path.join(DATA_DIR, 'pr-reviewer', 'last-tick');
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const STALE_AFTER_MS = 30 * 60 * 1000;
const REALERT_EVERY_MS = 24 * 60 * 60 * 1000;

const hostStartedAt = Date.now();
let lastAlertAt: number | null = null;

function lastTickAt(): number {
  try {
    return fs.statSync(LAST_TICK_PATH).mtimeMs;
  } catch {
    return hostStartedAt;
  }
}

async function alertOwner(silentSince: number): Promise<void> {
  const dm = readEnvFile(['PR_REVIEWS_DM']).PR_REVIEWS_DM || 'D0B5RV4BH37';
  const platformId = `slack:${dm}`;
  const mg = getMessagingGroupByPlatform('slack', platformId);
  const adapter = getDeliveryAdapter();
  if (!mg || !adapter) return;
  const text = [
    `⚠️ The PR dispatcher has not completed a tick since ${new Date(silentSince).toISOString()} — no PRs are being picked up.`,
    'Check `logs/pr-dispatch.log`, then reload it with:',
    `\`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nanoclaw.pr-dispatch.${INSTALL_SLUG}.plist\``,
  ].join('\n');
  await adapter.deliver('slack', platformId, null, 'chat', JSON.stringify({ text }), undefined, mg.instance);
}

async function check(): Promise<void> {
  const now = Date.now();
  const silentSince = lastTickAt();
  if (now - silentSince < STALE_AFTER_MS) {
    lastAlertAt = null;
    return;
  }
  if (lastAlertAt !== null && now - lastAlertAt < REALERT_EVERY_MS) return;
  lastAlertAt = now;
  log.warn('PR dispatcher is silent', { silentSince: new Date(silentSince).toISOString() });
  await alertOwner(silentSince);
}

setInterval(() => {
  check().catch((err) => log.error('PR dispatcher watchdog failed', { err }));
}, CHECK_INTERVAL_MS).unref();
