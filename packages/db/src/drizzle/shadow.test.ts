import { beforeEach, describe, expect, it, vi } from "vitest";
import { SHADOW_DIVERGENCE_KIND, shadowRead } from "./shadow";

// =============================================================
// shadow-read — unit tests
// =============================================================
//
// No DB here. We verify the structural comparator, the reject-on-
// primary-only path, and that a disagreement is logged without
// poisoning the caller's return value.

const warn = vi.fn();
const logger = { warn };

beforeEach(() => warn.mockClear());

describe("shadowRead — happy path", () => {
  it("returns primary's value when both sides agree", async () => {
    const result = await shadowRead(
      async () => ({ id: "x", attributes: { country: "TR" } }),
      async () => ({ id: "x", attributes: { country: "TR" } }),
      { name: "test.agree", logger },
    );
    expect(result).toEqual({ id: "x", attributes: { country: "TR" } });
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats objects with different key order as equal", async () => {
    await shadowRead(
      async () => ({ a: 1, b: 2 }),
      async () => ({ b: 2, a: 1 }),
      { name: "test.key-order", logger },
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("compares Date objects by time, not identity", async () => {
    const d1 = new Date("2026-04-20T00:00:00Z");
    const d2 = new Date("2026-04-20T00:00:00Z");
    await shadowRead(
      async () => ({ firstSeenAt: d1 }),
      async () => ({ firstSeenAt: d2 }),
      { name: "test.date", logger },
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("shadowRead — divergence", () => {
  it("logs a result-mismatch when fields differ", async () => {
    const result = await shadowRead(
      async () => ({ id: "x", attributes: { country: "TR" } }),
      async () => ({ id: "x", attributes: { country: "US" } }),
      { name: "test.attrs", context: { appUserId: "abc" }, logger },
    );
    expect(result).toEqual({ id: "x", attributes: { country: "TR" } });
    expect(warn).toHaveBeenCalledTimes(1);
    const payload = warn.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload.kind).toBe(SHADOW_DIVERGENCE_KIND.ResultMismatch);
    expect(payload.diff).toContain("country");
    expect(payload.context).toEqual({ appUserId: "abc" });
  });

  it("logs an array-length divergence", async () => {
    await shadowRead(
      async () => [1, 2, 3],
      async () => [1, 2],
      { name: "test.arr", logger },
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({
      kind: SHADOW_DIVERGENCE_KIND.ResultMismatch,
    });
  });

  it("logs shadow-threw-primary-ok and returns primary", async () => {
    const result = await shadowRead(
      async () => 42,
      async () => {
        throw new Error("shadow boom");
      },
      { name: "test.shadow-throws", logger },
    );
    expect(result).toBe(42);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({
      kind: SHADOW_DIVERGENCE_KIND.ShadowThrewPrimaryOk,
    });
  });

  it("logs primary-threw-shadow-ok and re-throws the primary error", async () => {
    await expect(
      shadowRead(
        async () => {
          throw new Error("primary boom");
        },
        async () => 42,
        { name: "test.primary-throws", logger },
      ),
    ).rejects.toThrow(/primary boom/);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({
      kind: SHADOW_DIVERGENCE_KIND.PrimaryThrewShadowOk,
    });
  });
});

describe("shadowRead — enabled=false", () => {
  it("skips the shadow call entirely", async () => {
    const shadow = vi.fn(async () => 99);
    const result = await shadowRead(
      async () => 42,
      shadow,
      { name: "test.disabled", enabled: false, logger },
    );
    expect(result).toBe(42);
    expect(shadow).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
