import { configDefaults, defineConfig } from "vitest/config";

// =============================================================
// Container-heavy suites
// =============================================================
//
// These start their own Redpanda and/or ClickHouse via testcontainers rather
// than using the ambient stack — up to two containers per file. Ten worker
// threads doing that at once is more than a laptop's Docker will carry: the
// containers do not fail to start, they start and then die, and the suite
// reports "(HTTP code 409) container stopped/paused - container … is not
// running". Nine of them run together produced 6 such deaths and 3 failed
// files; the same nine with two workers pass 27/27. Since which file loses
// depends on scheduling, it reads as flakiness rather than as a capacity
// limit.
//
// So they run in a second pass with the concurrency turned down, instead of
// throttling the ~350 files that have no such problem. `pnpm test` runs both
// passes; neither is optional and no file belongs to both.
//
// These are exactly the files that pin fixed host ports — they pin them
// BECAUSE a Kafka client connects on the address the broker advertises, which
// has to be known before the container starts. tests/host-port-allocations.test.ts
// keeps those pins unique; this list keeps them from starving each other.
const CONTAINER_SUITES = [
  "tests/ch-kafka-engine.integration.test.ts",
  "tests/outbox-replay-idempotency.test.ts",
  "tests/outbox-revenue-credit-replay.integration.test.ts",
  "tests/mrr-clickhouse-only.integration.test.ts",
  "tests/analytics-clickhouse.integration.test.ts",
  "tests/revenue-aggregates-idempotency.integration.test.ts",
  "tests/notifier.integration.test.ts",
  "tests/notifier-entry.integration.test.ts",
  "tests/outbox-dispatcher.integration.test.ts",
];

/** Second pass. Set by the `test` script; not meant to be used by hand. */
const containerPass = process.env.VITEST_CONTAINER_PASS === "1";

export default defineConfig({
  test: {
    environment: "node",
    include: containerPass
      ? CONTAINER_SUITES
      : ["tests/**/*.test.ts", "src/**/*.test.ts"],
    exclude: containerPass
      ? [...configDefaults.exclude]
      : [...configDefaults.exclude, ...CONTAINER_SUITES],
    // Two passes rather than two vitest `projects`: projects share one run,
    // so their globalSetup teardowns overlap — and this one drops every
    // `rovenue_test_w*` database. One pass tearing those down while the other
    // is still using them would trade a capacity problem for a data race.
    // Sequential invocations each get a complete, private lifecycle.
    ...(containerPass ? { maxWorkers: 2 } : {}),
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
