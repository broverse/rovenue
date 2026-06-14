import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The single-dispatcher contract: exactly one process may run the
// outbox dispatcher. In compose, every worker MUST override
// OUTBOX_DISPATCHER_ENABLED to "false" so it can never double-dispatch.
const WORKERS = [
  "notifier-worker",
  "digest-scheduler",
  "send-email-worker",
  "send-push-worker",
];

describe("single-dispatcher contract (compose)", () => {
  const compose = readFileSync(
    join(__dirname, "../../../../docker-compose.yml"),
    "utf8",
  );

  it.each(WORKERS)(
    "%s declares OUTBOX_DISPATCHER_ENABLED: \"false\"",
    (worker) => {
      // Slice the service block from its header to the next top-level
      // service (two-space-indented `name:`), then assert the override.
      const start = compose.indexOf(`\n  ${worker}:`);
      expect(start, `${worker} service missing`).toBeGreaterThan(-1);
      const rest = compose.slice(start + 1);
      const next = rest.search(/\n {2}[a-z0-9_-]+:\n/);
      const block = next === -1 ? rest : rest.slice(0, next);
      expect(block).toMatch(/OUTBOX_DISPATCHER_ENABLED:\s*["']?false["']?/);
    },
  );
});
