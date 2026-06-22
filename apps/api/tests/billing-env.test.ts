import { beforeEach, describe, expect, it, vi } from "vitest";

describe("billing env vars", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("HOST_MODE defaults to 'self' when unset", async () => {
    const original = process.env.HOST_MODE;
    delete process.env.HOST_MODE;
    try {
      const { env } = await import("../src/lib/env");
      expect(env.HOST_MODE).toBe("self");
    } finally {
      if (original !== undefined) process.env.HOST_MODE = original;
    }
  });

  it("HOST_MODE=cloud enables billing", async () => {
    process.env.HOST_MODE = "cloud";
    try {
      const { isBillingEnabled } = await import("../src/lib/host-mode");
      expect(isBillingEnabled()).toBe(true);
    } finally {
      process.env.HOST_MODE = "cloud"; // restore setup.ts default
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

  it("STRIPE_BILLING_SECRET_KEY is required when HOST_MODE=cloud in production", async () => {
    const origNode = process.env.NODE_ENV;
    const origHostMode = process.env.HOST_MODE;
    const origKey = process.env.STRIPE_BILLING_SECRET_KEY;
    const origWebhook = process.env.STRIPE_BILLING_WEBHOOK_SECRET;

    // Set production with HOST_MODE=cloud but no Stripe keys
    process.env.NODE_ENV = "production";
    process.env.HOST_MODE = "cloud";
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
      if (origHostMode !== undefined)
        process.env.HOST_MODE = origHostMode;
      else delete process.env.HOST_MODE;
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
