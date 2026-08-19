import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    // container/*.test.ts: top-level only — container/agent-runner tests run
    // under Bun (they depend on bun:sqlite) and must not be picked up here.
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts', 'scripts/**/*.test.ts', 'container/*.test.ts'],
    // The cross-session-context tests exercise the fan; this install disables
    // it in .env (one thread = one PR = one blind session), and readEnvFile
    // reads the repo .env from cwd. Pin the feature on for unit tests.
    env: { CROSS_SESSION_CONTEXT: 'on' },
  },
});
