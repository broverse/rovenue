import { configDefaults, defineConfig } from "vitest/config";

// =============================================================
// Two-pass split: container suites run separately
// =============================================================
//
// `tests/partman-registration.integration.test.ts` is the only file in this
// package that starts a container. It does two expensive things before its
// first assertion: `GenericContainer.fromDockerfile(deploy/postgres)` builds
// the pg_partman image, and a stock `postgres:16-alpine` is pulled for the
// no-partman half of the suite. Its own SETUP_TIMEOUT_MS is 900_000.
//
// With no config at all, vitest's default glob swept that file into every
// run — so `pnpm test` at the repo root paid an image build and an image
// pull on every full run, CI and local, and inherited this repo's standing
// footgun: vitest does not fail fast when Docker is down, it HANGS.
//
// apps/api solved exactly this and the shape is copied verbatim
// (apps/api/vitest.config.ts): a named list of container files, excluded
// from the default pass and included — alone — in a second pass driven by
// VITEST_CONTAINER_PASS. Two sequential vitest invocations rather than two
// vitest `projects`, because projects share one run and their globalSetup
// teardowns overlap.
//
// A skipIf on Docker availability was the alternative and was rejected: it
// would have to probe the daemon, and a probe that starts returning false —
// a renamed socket, a CI runner without a mounted docker.sock, a thrown
// error swallowed into `false` — silently converts the only end-to-end
// proof of migration 0130 into a permanent green skip. This repo has
// shipped that failure more than once. A static include/exclude list cannot
// drift that way: vitest exits 1 with "No test files found" if the container
// pass ever matches nothing, so the gate breaking is itself a red build.
const CONTAINER_SUITES = ["tests/partman-registration.integration.test.ts"];

/** Second pass. Set by the `test` script; not meant to be used by hand. */
const containerPass = process.env.VITEST_CONTAINER_PASS === "1";

/** Matches what vitest's default glob discovered before this file existed,
 *  so the split changes WHICH pass a file runs in and nothing else. */
const ALL_SUITES = ["src/**/*.test.ts", "tests/**/*.test.ts"];

export default defineConfig({
  test: {
    environment: "node",
    include: containerPass ? CONTAINER_SUITES : ALL_SUITES,
    exclude: containerPass
      ? [...configDefaults.exclude]
      : [...configDefaults.exclude, ...CONTAINER_SUITES],
    // One container-building file, and it builds an image: give it the
    // machine to itself rather than racing the Docker daemon.
    maxWorkers: containerPass ? 1 : 2,
    minWorkers: 1,
  },
});
