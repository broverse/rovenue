import { beforeEach, describe, expect, it, vi } from "vitest";

describe("OUTBOX_DISPATCHER_ENABLED env var", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("defaults to true when unset", async () => {
    const original = process.env.OUTBOX_DISPATCHER_ENABLED;
    delete process.env.OUTBOX_DISPATCHER_ENABLED;
    try {
      const { env } = await import("../src/lib/env");
      expect(env.OUTBOX_DISPATCHER_ENABLED).toBe(true);
    } finally {
      if (original !== undefined) process.env.OUTBOX_DISPATCHER_ENABLED = original;
    }
  });

  it("parses \"false\" to false", async () => {
    const original = process.env.OUTBOX_DISPATCHER_ENABLED;
    process.env.OUTBOX_DISPATCHER_ENABLED = "false";
    try {
      const { env } = await import("../src/lib/env");
      expect(env.OUTBOX_DISPATCHER_ENABLED).toBe(false);
    } finally {
      if (original !== undefined) process.env.OUTBOX_DISPATCHER_ENABLED = original;
      else delete process.env.OUTBOX_DISPATCHER_ENABLED;
    }
  });
});
