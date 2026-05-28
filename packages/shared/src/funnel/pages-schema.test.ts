import { describe, expect, it } from "vitest";
import { pageSchema, pagesArraySchema } from "./pages-schema";

describe("pageSchema", () => {
  it("accepts a single_choice page with options at the top level", () => {
    const ok = pageSchema.safeParse({
      id: "pg_01",
      type: "single_choice",
      question_id: "goal",
      title: "What's your goal?",
      options: [
        { label: "Lose weight", value: "lose_weight" },
        { label: "Build muscle", value: "build_muscle" },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it("accepts info, paywall, and success pages with dashboard-flat fields", () => {
    expect(
      pageSchema.safeParse({ id: "pg_info", type: "info", title: "T", body: "B" }).success,
    ).toBe(true);
    expect(
      pageSchema.safeParse({
        id: "pg_pay",
        type: "paywall",
        headline: "H",
        benefits: ["a"],
      }).success,
    ).toBe(true);
    expect(
      pageSchema.safeParse({ id: "pg_ok", type: "success", title: "T", body: "B", cta: "Open" })
        .success,
    ).toBe(true);
  });

  it("rejects unknown page type", () => {
    const result = pageSchema.safeParse({ id: "pg_x", type: "unknown_type" });
    expect(result.success).toBe(false);
  });

  it("accepts inlined branching (next_rules + default_next) on a page", () => {
    const ok = pageSchema.safeParse({
      id: "pg_q",
      type: "single_choice",
      question_id: "goal",
      next_rules: [
        {
          id: "r1",
          condition: {
            op: "all",
            clauses: [{ question_id: "goal", op: "eq", value: "lose_weight" }],
          },
          goto: "pg_plan",
        },
      ],
      default_next: "paywall",
    });
    expect(ok.success).toBe(true);
  });

  it("tolerates unknown extra fields (passthrough)", () => {
    const ok = pageSchema.safeParse({
      id: "pg_x",
      type: "info",
      title: "T",
      somethingNew: "value",
    });
    expect(ok.success).toBe(true);
  });

  it("pagesArraySchema rejects duplicate ids", () => {
    const result = pagesArraySchema.safeParse([
      { id: "pg_1", type: "info", title: "A" },
      { id: "pg_1", type: "info", title: "C" },
    ]);
    expect(result.success).toBe(false);
  });
});
