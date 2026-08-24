import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression: ALLOW_UNVERIFIED_WEBHOOKS was declared with z.coerce.boolean(),
// which runs JS Boolean() — and Boolean("false") === true, so the literal
// string "false" silently ENABLED the webhook-signature bypass. The flag must
// parse the same way every other boolean env var does: only "true" is true.
describe("ALLOW_UNVERIFIED_WEBHOOKS env var", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function parseWith(value: string | undefined): Promise<boolean> {
    const original = process.env.ALLOW_UNVERIFIED_WEBHOOKS;
    if (value === undefined) delete process.env.ALLOW_UNVERIFIED_WEBHOOKS;
    else process.env.ALLOW_UNVERIFIED_WEBHOOKS = value;
    try {
      const { env } = await import("../src/lib/env");
      return env.ALLOW_UNVERIFIED_WEBHOOKS;
    } finally {
      if (original !== undefined)
        process.env.ALLOW_UNVERIFIED_WEBHOOKS = original;
      else delete process.env.ALLOW_UNVERIFIED_WEBHOOKS;
    }
  }

  it("defaults to false when unset", async () => {
    expect(await parseWith(undefined)).toBe(false);
  });

  it('parses "false" to false (the bug: coerce.boolean made this true)', async () => {
    expect(await parseWith("false")).toBe(false);
  });

  it('parses "true" to true', async () => {
    expect(await parseWith("true")).toBe(true);
  });
});
