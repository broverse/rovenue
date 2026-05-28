import { describe, expect, it, vi } from "vitest";
import { evaluateQuota } from "./quota";

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
