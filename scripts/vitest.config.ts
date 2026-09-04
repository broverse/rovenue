import { defineConfig } from "vitest/config";

// This package has exactly one test file today
// (asset-headers.integration.test.ts), which starts its own MinIO
// container via testcontainers. apps/api's vitest.config.ts runs
// container-starting suites through a throttled two-pass
// (CONTAINER_SUITES / VITEST_CONTAINER_PASS) scheme — that exists because
// ~10 of its suites share databases/topics and race on teardown when run
// at full worker concurrency. Nothing here shares state across files, so
// that machinery has no problem to solve yet; a single generous timeout is
// enough. Revisit if a second container-starting file lands in this
// package.
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
