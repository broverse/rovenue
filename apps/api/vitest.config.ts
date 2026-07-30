import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    // Builds the migrated template database the per-worker clones come from,
    // and drops every worker database afterwards. See global-setup.ts for why
    // the suite needed isolating at all.
    globalSetup: ["./tests/global-setup.ts"],
    // vitest 2+ changed the default pool from "threads" to "forks"; the
    // sns-signature test makes a real outbound fetch that times out under
    // the forks runner on macOS. "threads" restores the 1.x behaviour.
    pool: "threads",
    // vitest's 5s default is a wall-clock deadline, and this suite runs one
    // worker thread per core alongside Postgres, ClickHouse and Redpanda —
    // so a test can blow it without doing 5s of work. That produced a
    // MOVING set of failures: three consecutive runs of the same commit
    // failed the funnel suites, then the stripe-connect suites, then
    // funnel-host-lookup, all with "Test timed out in 5000ms" and all
    // passing when run alone. Raising the deadline to 30s took the timeout
    // count from 8 to 0 without changing a line of application code.
    //
    // This is a deadline, not a budget: nothing here legitimately needs 30s,
    // so a test that now hits the limit is genuinely stuck rather than
    // starved, which is the signal the 5s default was too noisy to give.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
