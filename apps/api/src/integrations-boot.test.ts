import { describe, expect, it, vi, beforeEach } from "vitest";

// The heavy boot dependencies are stubbed at the module boundary so this
// file can assert the BOOT ORDER without Redis, Postgres or Kafka. Only the
// ordering matters here: topics must be provisioned before the fan-out
// consumer subscribes to them.
const callOrder: string[] = [];

const assertTopicsMock = vi.fn(async (topics: Iterable<string>) => {
  callOrder.push(`assertTopics:${[...topics].sort().join(",")}`);
});
const startFanoutMock = vi.fn(async () => {
  callOrder.push("startIntegrationsFanout");
  return { stop: async () => {} };
});

vi.mock("./workers/outbox-dispatcher", () => ({
  assertTopics: (topics: Iterable<string>) => assertTopicsMock(topics),
}));

vi.mock("./services/integrations-fanout/consumer", () => ({
  startIntegrationsFanout: () => startFanoutMock(),
}));

vi.mock("./workers/integrations-deliver", () => ({
  ensureIntegrationsDeliverWorker: async () => ({ stop: async () => {} }),
}));

vi.mock("./services/integrations-fanout/connection-cache", () => ({
  createConnectionCache: () => ({ get: async () => [] }),
}));

vi.mock("bullmq", () => ({
  Queue: class {
    add = async () => undefined;
    close = async () => undefined;
  },
}));

vi.mock("ioredis", () => ({
  Redis: class {
    on = () => this;
    quit = async () => undefined;
  },
}));

vi.mock("@rovenue/db", () => ({
  getDb: () => ({}),
  drizzle: {
    integrationConnectionRepo: { listActiveConnectionsForProject: async () => [] },
  },
}));

import { bootIntegrations } from "./integrations-boot";
import { fanoutTopics } from "./services/integrations/registry";

describe("bootIntegrations", () => {
  beforeEach(() => {
    callOrder.length = 0;
    vi.clearAllMocks();
  });

  it("returns a controller with stop()", async () => {
    const handle = await bootIntegrations({ autoStart: false });
    expect(typeof handle.stop).toBe("function");
    await handle.stop();
  });

  it("provisions every fan-out topic BEFORE the consumer subscribes", async () => {
    const handle = await bootIntegrations();

    expect(assertTopicsMock).toHaveBeenCalledTimes(1);
    expect([...assertTopicsMock.mock.calls[0]![0]].sort()).toEqual(
      [...fanoutTopics()].sort(),
    );
    expect(callOrder).toEqual([
      `assertTopics:${[...fanoutTopics()].sort().join(",")}`,
      "startIntegrationsFanout",
    ]);

    await handle.stop();
  });
});
