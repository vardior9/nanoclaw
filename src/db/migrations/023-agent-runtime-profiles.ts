import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/** Explicit runtime policies for narrow, disposable-task agents. */
export const migration023: Migration = {
  version: 23,
  name: 'agent-runtime-profiles',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE container_configs ADD COLUMN continuation_mode TEXT NOT NULL DEFAULT 'resume';
      ALTER TABLE container_configs ADD COLUMN context_profile TEXT NOT NULL DEFAULT 'standard';
    `);
  },
};
