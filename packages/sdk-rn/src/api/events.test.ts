import { describe, it, expect, vi, beforeEach } from "vitest";

const track = vi.fn(async () => {});
vi.mock("../core/native", () => ({ getNative: () => ({ track }) }));

import { track as trackApi } from "./events";

describe("track", () => {
  beforeEach(() => track.mockClear());

  it("stamps occurredAt and forwards a compact camelCase envelope", async () => {
    await trackApi("purchase", { amount: "9.99", currency: "USD" });
    expect(track).toHaveBeenCalledTimes(1);
    const json = track.mock.calls[0][0] as string;
    const env = JSON.parse(json);
    expect(env.eventType).toBe("purchase");
    expect(env.amount).toBe("9.99");
    expect(env.currency).toBe("USD");
    expect(typeof env.occurredAt).toBe("string");
    expect(env.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // undefined fields are stripped, not serialised as null
    expect("subscriberId" in env).toBe(false);
    expect("productId" in env).toBe(false);
  });

  it("honours an explicit occurredAt and identityContext", async () => {
    await trackApi("lead", {
      occurredAt: "2026-06-20T10:00:00Z",
      identityContext: { email: "a@b.com" },
    });
    const env = JSON.parse(track.mock.calls[0][0] as string);
    expect(env.occurredAt).toBe("2026-06-20T10:00:00Z");
    expect(env.identityContext).toEqual({ email: "a@b.com" });
  });
});
