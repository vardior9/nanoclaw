import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { loadState, parsePrKey, STATE_DIR } from './lib.js';

const EVENT_TYPES = ['head.changed', 'review.submitted', 'state.changed']
  .map((event) => `com.github.pull_request.${event}.v1`);
const SUBSCRIPTION_LIMIT = 40;
const RECONCILE_MS = 15_000;
const RETRY_MS = 15 * 60_000;
const RENEW_BEFORE_MS = 60 * 60_000;
const subscriptionsPath = path.join(STATE_DIR, 'event-subscriptions.json');
const ghEnv = { ...process.env, GH_HOST: 'github.com', GH_DEBUG: '', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
const execGh = promisify(execFile);

interface Subscription {
  id: string;
  expiresAt: string;
}

type Wake = (key: string, event: string) => Promise<boolean>;

function log(message: string): void {
  console.log(`[pr-reviewer-events] ${new Date().toISOString()} ${message}`);
}

function httpStatus(message: string): string | undefined {
  return /\bHTTP (\d{3})\b/.exec(message)?.[1];
}

async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execGh('gh', args, { env: ghEnv, timeout: 10_000 });
    return stdout;
  } catch (err) {
    const { stderr } = err as { stderr?: string };
    throw new Error(httpStatus(stderr ?? '') ?? 'GitHub CLI error');
  }
}

function readSubscriptions(): Map<string, Subscription> {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(subscriptionsPath, 'utf8'))));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return new Map();
  }
}

function saveSubscriptions(subscriptions: Map<string, Subscription>): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${subscriptionsPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(subscriptions)) + '\n');
  fs.renameSync(tmp, subscriptionsPath);
}

function openStream(
  subscription: Subscription,
  onEvent: (event: string) => void,
  onError: (reason: string) => void,
): () => Promise<void> {
  const child = spawn('gh', [
    'event', 'listen', '--subscription', subscription.id, '--follow', '--jq', '.type',
  ], { env: ghEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let stopping = false;
  let failure = 'stream disconnected';
  child.on('error', () => { failure = 'GitHub CLI error'; });
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => {
      resolve();
      if (!stopping) onError(failure);
    });
  });

  createInterface({ input: child.stderr }).on('line', (line) => {
    if (line === 'Listening for events.' || line === 'Listening for events on a new subscription.') {
      failure = 'stream disconnected';
      onEvent('attach');
    }
    const status = httpStatus(line);
    if (status === '403' || status === '429') onError(status);
    if (line.includes(`subscription ${subscription.id} `) && /was not found|was deleted|expired/.test(line)) {
      failure = 'subscription gone';
    }
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (EVENT_TYPES.includes(line)) onEvent(line);
  });

  return async () => {
    stopping = true;
    child.kill();
    const kill = setTimeout(() => child.kill('SIGKILL'), 1000);
    try {
      await closed;
    } finally {
      clearTimeout(kill);
    }
  };
}

export async function followPullEvents(wake: Wake, signal: AbortSignal): Promise<void> {
  let subscriptions: Map<string, Subscription> | undefined;
  const streams = new Map<string, () => Promise<void>>();
  const pending = new Map<string, string>();
  const missing = new Set<string>();
  let retryAt = 0;
  let drain: Promise<void> | undefined;

  function fallBack(reason: string): void {
    if (signal.aborted || Date.now() < retryAt) return;
    retryAt = reason === '403' ? Infinity : Date.now() + RETRY_MS;
    pending.clear();
    const detail = /^\d{3}$/.test(reason) ? `HTTP ${reason}` : reason;
    log(`tick-only (${detail}), ${retryAt === Infinity ? 'restart to retry' : 'retry in 15m'}`);
  }

  async function drainWakes(): Promise<void> {
    while (!signal.aborted && pending.size) {
      const [key, event] = pending.entries().next().value!;
      pending.delete(key);
      try {
        if (await wake(key, event)) continue;
        if (!pending.has(key) && Date.now() >= retryAt) pending.set(key, event);
        await delay(5000);
      } catch {
        log(`dispatch failed for ${key}; the scheduled tick will retry`);
      }
    }
  }

  function queueWake(key: string, event: string): void {
    if (signal.aborted || Date.now() < retryAt) return;
    log(`${event} ${key}`);
    pending.set(key, event);
    drain ??= Promise.resolve().then(drainWakes).finally(() => { drain = undefined; });
  }

  async function stopStream(key: string): Promise<void> {
    const stop = streams.get(key);
    streams.delete(key);
    await stop?.();
  }

  async function removeSubscription(key: string, subscription: Subscription): Promise<void> {
    await stopStream(key);
    try {
      await gh(['api', '-X', 'DELETE', `event-subscriptions/${encodeURIComponent(subscription.id)}`]);
    } catch (err) {
      if ((err as Error).message !== '404') throw err;
    }
    subscriptions?.delete(key);
    missing.delete(key);
    if (subscriptions) saveSubscriptions(subscriptions);
    log(`deleted subscription ${key}`);
  }

  async function reconcile(): Promise<void> {
    subscriptions ??= readSubscriptions();
    const tracked = new Set(Object.keys(loadState(true)));
    for (const [key, subscription] of subscriptions) {
      if (!tracked.has(key) || missing.has(key) || Date.parse(subscription.expiresAt) - Date.now() <= RENEW_BEFORE_MS) {
        await removeSubscription(key, subscription);
      }
    }

    for (const key of tracked) {
      if (signal.aborted || Date.now() < retryAt) return;
      if (streams.has(key)) continue;
      let subscription = subscriptions.get(key);
      if (!subscription) {
        if (subscriptions.size >= SUBSCRIPTION_LIMIT) continue;
        const { owner, repo, number } = parsePrKey(key);
        subscription = JSON.parse(await gh([
          'event', 'subscription', 'create', '--json', 'id,expiresAt',
          '--resource', `https://github.com/${owner}/${repo}/pull/${number}`,
          '--event', EVENT_TYPES.join(','),
        ])) as Subscription;
        subscriptions.set(key, subscription);
        saveSubscriptions(subscriptions);
      }
      if (signal.aborted || Date.now() < retryAt) return;
      streams.set(key, openStream(subscription, (event) => queueWake(key, event), (reason) => {
        if (reason === 'subscription gone') missing.add(key);
        fallBack(reason);
      }));
    }
  }

  try {
    while (!signal.aborted) {
      if (Date.now() >= retryAt) {
        try {
          await reconcile();
        } catch (err) {
          const reason = (err as Error).message;
          fallBack(/^\d{3}$/.test(reason) ? reason : 'subscription operation failed');
        }
      }
      if (Date.now() < retryAt) await Promise.all([...streams.keys()].map(stopStream));
      await delay(RECONCILE_MS, undefined, { signal });
    }
  } catch (err) {
    if (!signal.aborted) throw err;
  } finally {
    await Promise.all([...streams.keys()].map(stopStream));
    await drain;
    if (subscriptions && Date.now() >= retryAt) {
      const results = await Promise.allSettled([...subscriptions].map(([key, sub]) => removeSubscription(key, sub)));
      if (results.some((result) => result.status === 'rejected')) log('subscription cleanup incomplete; saved IDs will be retried');
    }
  }
}
