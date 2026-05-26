import { describe, expect, it } from "vitest";
import { pageSchema, pagesArraySchema } from "./pages-schema";

describe("pageSchema", () => {
  it("accepts a question_single page with options", () => {
    const ok = pageSchema.safeParse({
      id: "pg_01",
      type: "question_single",
      config: {
        question_id: "goal",
        title: "What's your goal?",
        options: [
          { id: "o1", label: "Lose weight", value: "lose_weight" },
          { id: "o2", label: "Build muscle", value: "build_muscle" },
        ],
      },
    });
    expect(ok.success).toBe(true);
  });

  it("rejects a question_single page with empty options", () => {
    const result = pageSchema.safeParse({
      id: "pg_01",
      type: "question_single",
      config: { question_id: "g", title: "T", options: [] },
    });
    expect(result.success).toBe(false);
  });

  it("accepts info, paywall, and success pages", () => {
    expect(
      pageSchema.safeParse({
        id: "pg_info",
        type: "info",
        config: { title: "T", body_markdown: "B" },
      }).success,
    ).toBe(true);
    expect(
      pageSchema.safeParse({
        id: "pg_pay",
        type: "paywall",
        config: { product_id: "prod_1", headline: "H", bullets: ["a"] },
      }).success,
    ).toBe(true);
    expect(
      pageSchema.safeParse({
        id: "pg_ok",
        type: "success",
        config: { headline: "H", body: "B", open_app_label: "Open" },
      }).success,
    ).toBe(true);
  });

  it("rejects unknown page type", () => {
    const result = pageSchema.safeParse({
      id: "pg_x",
      type: "unknown_type",
      config: {},
    });
    expect(result.success).toBe(false);
  });

  it("pagesArraySchema rejects duplicate ids", () => {
    const result = pagesArraySchema.safeParse([
      { id: "pg_1", type: "info", config: { title: "A", body_markdown: "B" } },
      { id: "pg_1", type: "info", config: { title: "C", body_markdown: "D" } },
    ]);
    expect(result.success).toBe(false);
  });
});
