import { describe, expect, it } from "vitest";
import { validateFunnelGraph } from "./branching-validator";

describe("validateFunnelGraph", () => {
  it("accepts a minimal valid funnel (info → paywall → success)", () => {
    const result = validateFunnelGraph([
      { id: "pg_1", type: "info", config: { title: "T", body_markdown: "B" } },
      {
        id: "pg_pay",
        type: "paywall",
        config: { product_id: "p", headline: "h", bullets: ["a"] },
      },
      {
        id: "pg_ok",
        type: "success",
        config: { headline: "h", body: "b", open_app_label: "Open" },
      },
    ]);
    expect(result.ok).toBe(true);
  });

  it("rejects missing paywall page", () => {
    const result = validateFunnelGraph([
      { id: "pg_1", type: "info", config: { title: "T", body_markdown: "B" } },
      {
        id: "pg_ok",
        type: "success",
        config: { headline: "h", body: "b", open_app_label: "Open" },
      },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === "MISSING_PAYWALL")).toBe(true);
    }
  });

  it("rejects missing success page", () => {
    const result = validateFunnelGraph([
      {
        id: "pg_pay",
        type: "paywall",
        config: { product_id: "p", headline: "h", bullets: ["a"] },
      },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === "MISSING_SUCCESS")).toBe(true);
    }
  });

  it("detects cycles in next_rules graph", () => {
    const result = validateFunnelGraph([
      { id: "pg_1", type: "info", config: {}, default_next: "pg_2" },
      { id: "pg_2", type: "info", config: {}, default_next: "pg_1" },
      {
        id: "pg_pay",
        type: "paywall",
        config: { product_id: "p", headline: "h", bullets: ["a"] },
      },
      {
        id: "pg_ok",
        type: "success",
        config: { headline: "h", body: "b", open_app_label: "Open" },
      },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === "CYCLE")).toBe(true);
    }
  });

  it("rejects duplicate question_id across pages", () => {
    const result = validateFunnelGraph([
      {
        id: "pg_1",
        type: "single_choice",
        question_id: "goal",
      },
      {
        id: "pg_2",
        type: "single_choice",
        question_id: "goal",
      },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === "DUPLICATE_QUESTION_ID")).toBe(true);
    }
  });

  it("rejects rule referencing unknown question_id", () => {
    const result = validateFunnelGraph([
      {
        id: "pg_1",
        type: "info",
        config: {},
        next_rules: [
          {
            id: "r",
            condition: { op: "all", clauses: [{ question_id: "ghost", op: "eq", value: "x" }] },
            goto: "pg_2",
          },
        ],
      },
      { id: "pg_2", type: "info", config: {} },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === "UNKNOWN_QUESTION_REF")).toBe(true);
    }
  });

  it("rejects rule goto pointing to a non-existent page", () => {
    const result = validateFunnelGraph([
      { id: "pg_1", type: "info", config: {}, default_next: "pg_missing" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === "UNKNOWN_GOTO")).toBe(true);
    }
  });
});
