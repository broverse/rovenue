import { beforeEach, describe, expect, it, vi } from "vitest";

describe("DATABASE_URL env requirement", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("is optional in development", async () => {
    const origNode = process.env.NODE_ENV;
    const origUrl = process.env.DATABASE_URL;
    process.env.NODE_ENV = "development";
    delete process.env.DATABASE_URL;
    try {
      const { env } = await import("../src/lib/env");
      expect(env.DATABASE_URL).toBeUndefined();
    } finally {
      process.env.NODE_ENV = origNode;
      if (origUrl !== undefined) process.env.DATABASE_URL = origUrl;
    }
  });

  it("is required in production", async () => {
    const origNode = process.env.NODE_ENV;
    const origUrl = process.env.DATABASE_URL;
    process.env.NODE_ENV = "production";
    delete process.env.DATABASE_URL;

    // Provide every other production-required var so DATABASE_URL is
    // the only thing missing — isolates the assertion to this check.
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    process.env.PUBSUB_PUSH_AUDIENCE = "https://example.com";
    process.env.APPLE_ROOT_CERTS_DIR = "/certs";
    process.env.BETTER_AUTH_SECRET = "secret";
    process.env.UNSUB_SIGNING_KEY = "b".repeat(64);
    process.env.CLICKHOUSE_URL = "http://localhost:8123";
    process.env.CLICKHOUSE_PASSWORD = "pass";
    process.env.KAFKA_BROKERS = "localhost:9092";

    try {
      await expect(import("../src/lib/env")).rejects.toThrow(/DATABASE_URL/);
    } finally {
      process.env.NODE_ENV = origNode;
      if (origUrl !== undefined) process.env.DATABASE_URL = origUrl;
      delete process.env.ENCRYPTION_KEY;
      delete process.env.PUBSUB_PUSH_AUDIENCE;
      delete process.env.APPLE_ROOT_CERTS_DIR;
      delete process.env.BETTER_AUTH_SECRET;
      delete process.env.UNSUB_SIGNING_KEY;
      delete process.env.CLICKHOUSE_URL;
      delete process.env.CLICKHOUSE_PASSWORD;
      delete process.env.KAFKA_BROKERS;
    }
  });
});
