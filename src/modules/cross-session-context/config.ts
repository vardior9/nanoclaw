/**
 * Cross-session context caps.
 *
 * Module-level constants for now — no DB config. Exported so the
 * router/delivery fan hooks, the host-sweep pruner, and tests share one
 * source of truth.
 */

import { readEnvFile } from '../../env.js';

/** channel_type stamped on fanned rows (cross-stream contract — the
 *  container formatter renders these as <cross-session-context> blocks). */
export const ECHO_CHANNEL_TYPE = 'session-echo';

/** echo.surface value stamped on same-messaging-group sibling echoes — a DM's
 *  parallel conversation-threads seeing each other (audience-subset rule: same
 *  DM = same audience). Wire contract fields stay {surface,label}; this is
 *  just a new surface value. */
export const ECHO_SIBLING_SURFACE = 'dm-thread';

/** echo.surface value stamped on task-session-source echoes — a scheduled
 *  task's delivered user-facing send, fanned ONLY into sessions of the
 *  messaging group it was delivered to (audience-subset rule: that surface
 *  already displayed the message, so the fan widens nothing). */
export const ECHO_TASK_SURFACE = 'task-delivery';

/** Per-message text cap on echo rows: head-truncated, '…' appended when cut. */
export const ECHO_TEXT_MAX_CHARS = 500;

/** Pending echo rows the sweep pruner keeps per session (newest first).
 *  One cap for all sessions: under the same-conversation audience rule,
 *  task sessions receive no echoes. */
export const ECHO_BACKLOG_CAP = 50;

/** Pending echo rows older than this are dropped regardless of the count caps. */
export const ECHO_MAX_AGE_DAYS = 7;

/** Backfill prelude surface: THIS DM's preceding timeline (first-class
 *  conversation history), distinct from live cross-thread fan echoes. */
export const ECHO_TIMELINE_SURFACE = 'dm-timeline';

/** Backfill prelude surface for group conversations: group surfaces can be
 *  per-thread too, so a new thread session is seeded with the channel's
 *  top-level timeline — same messaging group means the same audience. */
export const ECHO_CHANNEL_TIMELINE_SURFACE = 'channel-timeline';

/**
 * Master switch for BOTH halves of this module (live fan + new-session
 * backfill), read once from `.env` at startup.
 *
 * On by default. Installs where every conversation is an independent work
 * item set `CROSS_SESSION_CONTEXT=off`: the PR reviewer runs one thread — one
 * session — per pull request, and a fresh session must start blind. With the
 * fan on, a new PR session is born holding up to BACKFILL_LIMIT sibling PR
 * kickoffs as ambient context; live hit (2026-08-19, apiiro/lim#48655) was a
 * session that woke to 12 other PRs' "New PR ready for review" preludes and
 * answered "I'm sorry, but I couldn't complete the review in this run."
 * A persona rule telling the agent to ignore echo blocks is not enough —
 * the context is already spent by the time it reads it.
 */
let cachedEnabled: boolean | undefined;
export function crossSessionContextEnabled(): boolean {
  if (cachedEnabled === undefined) {
    // process.env wins so a single run (or the unit-test env, which exercises
    // the feature on) can override the install-wide `.env` setting.
    const raw = process.env.CROSS_SESSION_CONTEXT ?? readEnvFile(['CROSS_SESSION_CONTEXT']).CROSS_SESSION_CONTEXT ?? '';
    cachedEnabled = raw.trim().toLowerCase() !== 'off';
  }
  return cachedEnabled;
}
