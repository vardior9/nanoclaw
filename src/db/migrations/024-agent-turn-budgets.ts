import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/** Optional hard ceilings for narrow, disposable agent turns. */
export const migration024: Migration = {
  version: 24,
  name: 'agent-turn-budgets',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE container_configs ADD COLUMN turn_timeout_ms INTEGER;
      ALTER TABLE container_configs ADD COLUMN max_tool_calls_per_turn INTEGER;
    `);
  },
};
