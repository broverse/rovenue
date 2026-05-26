import { beforeEach, describe, expect, it, vi } from "vitest";

describe("billing env vars", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("BILLING_ENABLED defaults to false when unset", async () => {
    const original = process.env.BILLING_ENABLED;
    delete process.env.BILLING_ENABLED;
    try {
      const { env } = await import("../src/lib/env");
      expect(env.BILLING_ENABLED).toBe(false);
    } finally {
      if (original !== undefined) process.env.BILLING_ENABLED = original;
    }
  });

  it("BILLING_ENABLED=true parses to true", async () => {
    process.env.BILLING_ENABLED = "true";
    try {
      const { env } = await import("../src/lib/env");
      expect(env.BILLING_ENABLED).toBe(true);
    } finally {
      delete process.env.BILLING_ENABLED;
    }
  });

  it("STRIPE_BILLING_SECRET_KEY is optional in dev", async () => {
    const origNode = process.env.NODE_ENV;
    const origKey = process.env.STRIPE_BILLING_SECRET_KEY;
    process.env.NODE_ENV = "development";
    delete process.env.STRIPE_BILLING_SECRET_KEY;
    try {
      const { env } = await import("../src/lib/env");
      expect(env.STRIPE_BILLING_SECRET_KEY).toBeUndefined();
    } finally {
      process.env.NODE_ENV = origNode;
      if (origKey !== undefined)
        process.env.STRIPE_BILLING_SECRET_KEY = origKey;
    }
  });

  it("STRIPE_BILLING_SECRET_KEY is required when BILLING_ENABLED=true in production", async () => {
    const origNode = process.env.NODE_ENV;
    const origBilling = process.env.BILLING_ENABLED;
    const origKey = process.env.STRIPE_BILLING_SECRET_KEY;
    const origWebhook = process.env.STRIPE_BILLING_WEBHOOK_SECRET;

    // Set production with BILLING_ENABLED=true but no Stripe keys
    process.env.NODE_ENV = "production";
    process.env.BILLING_ENABLED = "true";
    delete process.env.STRIPE_BILLING_SECRET_KEY;
    delete process.env.STRIPE_BILLING_WEBHOOK_SECRET;

    // Provide all other required-in-production vars to isolate the billing check
    process.env.ENCRYPTION_KEY =
      "a".repeat(64);
    process.env.PUBSUB_PUSH_AUDIENCE = "https://example.com";
    process.env.APPLE_ROOT_CERTS_DIR = "/certs";
    process.env.BETTER_AUTH_SECRET = "secret";
    process.env.CLICKHOUSE_URL = "http://localhost:8123";
    process.env.CLICKHOUSE_PASSWORD = "pass";
    process.env.KAFKA_BROKERS = "localhost:9092";

    try {
      await expect(import("../src/lib/env")).rejects.toThrow();
    } finally {
      process.env.NODE_ENV = origNode;
      if (origBilling !== undefined)
        process.env.BILLING_ENABLED = origBilling;
      else delete process.env.BILLING_ENABLED;
      if (origKey !== undefined)
        process.env.STRIPE_BILLING_SECRET_KEY = origKey;
      if (origWebhook !== undefined)
        process.env.STRIPE_BILLING_WEBHOOK_SECRET = origWebhook;
      delete process.env.ENCRYPTION_KEY;
      delete process.env.PUBSUB_PUSH_AUDIENCE;
      delete process.env.APPLE_ROOT_CERTS_DIR;
      delete process.env.BETTER_AUTH_SECRET;
      delete process.env.CLICKHOUSE_URL;
      delete process.env.CLICKHOUSE_PASSWORD;
      delete process.env.KAFKA_BROKERS;
    }
  });
});
