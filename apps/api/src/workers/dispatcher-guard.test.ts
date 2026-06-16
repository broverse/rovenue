import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The single-dispatcher contract: exactly one process may run the
// outbox dispatcher. The dedicated `dispatcher` service is that one
// process; every OTHER service (the API and all auxiliary workers)
// MUST override OUTBOX_DISPATCHER_ENABLED to "false" so it can never
// double-dispatch. This frees `api` to scale horizontally.
const NON_DISPATCHER_SERVICES = [
  "api",
  "notifier-worker",
  "digest-scheduler",
  "send-email-worker",
  "send-push-worker",
];

const compose = readFileSync(
  join(__dirname, "../../../../docker-compose.yml"),
  "utf8",
);

// Slice a top-level compose service block from its header to the next
// two-space-indented `name:` (or EOF).
function serviceBlock(name: string): string {
  const start = compose.indexOf(`\n  ${name}:`);
  expect(start, `${name} service missing`).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.search(/\n {2}[a-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("single-dispatcher contract (compose)", () => {
  it.each(NON_DISPATCHER_SERVICES)(
    "%s declares OUTBOX_DISPATCHER_ENABLED: \"false\"",
    (service) => {
      expect(serviceBlock(service)).toMatch(
        /OUTBOX_DISPATCHER_ENABLED:\s*["']?false["']?/,
      );
    },
  );

  it("declares exactly one dedicated `dispatcher` service that runs the dispatcher", () => {
    const block = serviceBlock("dispatcher");
    // The dispatcher service is the single publisher: it must NOT be
    // disabled, and it must be pinned to one replica.
    expect(block).toMatch(/OUTBOX_DISPATCHER_ENABLED:\s*["']?true["']?/);
    expect(block).toMatch(/replicas:\s*1/);
  });
});
