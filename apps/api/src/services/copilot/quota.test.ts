import { describe, expect, it, vi } from "vitest";
import { evaluateQuota, resolveTier } from "./quota";

describe("evaluateQuota", () => {
  it("allows when unlimited", () => {
    const out = evaluateQuota({
      tier: "free",
      unlimited: true,
      usage: { messages: 50, inputTokens: 250_000, outputTokens: 50_000 },
    });
    expect(out.allowed).toBe(true);
    expect(out.exceeded).toBeNull();
  });

  it("blocks when message cap reached", () => {
    const out = evaluateQuota({
      tier: "free",
      unlimited: false,
      usage: { messages: 50, inputTokens: 0, outputTokens: 0 },
    });
    expect(out.allowed).toBe(false);
    expect(out.exceeded).toBe("messages");
  });

  it("blocks when input token cap reached", () => {
    const out = evaluateQuota({
      tier: "free",
      unlimited: false,
      usage: { messages: 10, inputTokens: 250_000, outputTokens: 0 },
    });
    expect(out.allowed).toBe(false);
    expect(out.exceeded).toBe("input_tokens");
  });

  it("allows under all caps", () => {
    const out = evaluateQuota({
      tier: "team",
      unlimited: false,
      usage: { messages: 100, inputTokens: 1_000, outputTokens: 100 },
    });
    expect(out.allowed).toBe(true);
  });
});

describe("resolveTier", () => {
  it("self-host (unlimited=true) → enterprise + unlimited", () => {
    expect(resolveTier({ project: { metadata: null }, env: {}, unlimited: true }))
      .toEqual({ tier: "enterprise", unlimited: true });
  });
  it("cloud (unlimited=false) → env tier, enforced", () => {
    expect(resolveTier({ project: { metadata: null }, env: { ROVI_TIER: "team" }, unlimited: false }))
      .toEqual({ tier: "team", unlimited: false });
  });
  it("cloud default tier is free when nothing set", () => {
    expect(resolveTier({ project: { metadata: null }, env: {}, unlimited: false }))
      .toEqual({ tier: "free", unlimited: false });
  });
  it("project metadata rovi_tier overrides env", () => {
    expect(resolveTier({ project: { metadata: { rovi_tier: "business" } }, env: { ROVI_TIER: "team" }, unlimited: false }))
      .toEqual({ tier: "business", unlimited: false });
  });
});
