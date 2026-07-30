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
  },
});
