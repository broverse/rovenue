import { describe, expect, it } from "vitest";
import { evaluateNext, type AnswerMap, type PageGraph } from "./branching-evaluator";

const pages: PageGraph = new Map([
  ["pg_1", { id: "pg_1", type: "question_single", config: { question_id: "goal" }, next_rules: [] }],
  ["pg_2", { id: "pg_2", type: "info", config: {} }],
  ["pg_3", { id: "pg_3", type: "info", config: {} }],
  ["pg_pay", { id: "pg_pay", type: "paywall", config: {} }],
]);

describe("evaluateNext", () => {
  it("returns sequential next when no rules match", () => {
    const result = evaluateNext({
      page: { id: "pg_1", type: "question_single", config: { question_id: "goal" } },
      pagesOrder: ["pg_1", "pg_2", "pg_3", "pg_pay"],
      answers: new Map([["goal", "build_muscle"]]),
      pagesById: pages,
    });
    expect(result).toEqual({ next: "page", pageId: "pg_2" });
  });

  it("returns rule's goto when 'all' condition matches", () => {
    const page = {
      id: "pg_1",
      type: "question_single",
      config: { question_id: "goal" },
      next_rules: [
        {
          id: "r1",
          condition: {
            op: "all" as const,
            clauses: [
              { question_id: "goal", op: "eq" as const, value: "lose_weight" },
              { question_id: "age", op: "gte" as const, value: 40 },
            ],
          },
          goto: "pg_3",
        },
      ],
    };
    const answers: AnswerMap = new Map<string, string | number>([
      ["goal", "lose_weight"],
      ["age", 42],
    ]);
    const result = evaluateNext({
      page,
      pagesOrder: ["pg_1", "pg_2", "pg_3", "pg_pay"],
      answers,
      pagesById: pages,
    });
    expect(result).toEqual({ next: "page", pageId: "pg_3" });
  });

  it("falls back to default_next when no rule matches", () => {
    const page = {
      id: "pg_1",
      type: "question_single",
      config: { question_id: "goal" },
      next_rules: [],
      default_next: "pg_pay" as const,
    };
    expect(
      evaluateNext({
        page,
        pagesOrder: ["pg_1", "pg_2", "pg_pay"],
        answers: new Map(),
        pagesById: pages,
      }),
    ).toEqual({ next: "page", pageId: "pg_pay" });
  });

  it("'any' rule short-circuits on first match", () => {
    const page = {
      id: "pg_1",
      type: "question_single",
      config: {},
      next_rules: [
        {
          id: "r1",
          condition: {
            op: "any" as const,
            clauses: [
              { question_id: "missing", op: "eq" as const, value: "x" },
              { question_id: "goal", op: "eq" as const, value: "lose_weight" },
            ],
          },
          goto: "end" as const,
        },
      ],
    };
    expect(
      evaluateNext({
        page,
        pagesOrder: ["pg_1", "pg_2"],
        answers: new Map([["goal", "lose_weight"]]),
        pagesById: pages,
      }),
    ).toEqual({ next: "end" });
  });

  it("'in' and 'between' operate as expected", () => {
    const page = {
      id: "pg_1",
      type: "info",
      config: {},
      next_rules: [
        {
          id: "rIn",
          condition: {
            op: "all" as const,
            clauses: [{ question_id: "goal", op: "in" as const, value: ["a", "b"] }],
          },
          goto: "pg_2",
        },
        {
          id: "rBtw",
          condition: {
            op: "all" as const,
            clauses: [{ question_id: "age", op: "between" as const, value: [18, 65] }],
          },
          goto: "pg_3",
        },
      ],
    };
    expect(
      evaluateNext({
        page,
        pagesOrder: ["pg_1", "pg_2", "pg_3"],
        answers: new Map([["age", 30]]),
        pagesById: pages,
      }),
    ).toEqual({ next: "page", pageId: "pg_3" });
  });

  it("is_answered / is_not_answered evaluate against the map", () => {
    const page = {
      id: "pg_1",
      type: "info",
      config: {},
      next_rules: [
        {
          id: "r1",
          condition: {
            op: "all" as const,
            clauses: [{ question_id: "email", op: "is_not_answered" as const }],
          },
          goto: "pg_2",
        },
      ],
    };
    expect(
      evaluateNext({
        page,
        pagesOrder: ["pg_1", "pg_2", "pg_3"],
        answers: new Map(),
        pagesById: pages,
      }),
    ).toEqual({ next: "page", pageId: "pg_2" });
  });

  it("returns 'end' when last page has no rules and no successor", () => {
    expect(
      evaluateNext({
        page: { id: "pg_pay", type: "paywall", config: {} },
        pagesOrder: ["pg_1", "pg_pay"],
        answers: new Map(),
        pagesById: pages,
      }),
    ).toEqual({ next: "end" });
  });

  it("returns the paywall page id on sequential fall-through", () => {
    const testPages: PageGraph = new Map([
      ["pg_info", { id: "pg_info", type: "info", config: {} }],
      ["pg_pay", { id: "pg_pay", type: "paywall", config: {} }],
    ]);
    expect(
      evaluateNext({
        page: { id: "pg_info", type: "info", config: {} },
        pagesOrder: ["pg_info", "pg_pay"],
        answers: new Map(),
        pagesById: testPages,
      }),
    ).toEqual({ next: "page", pageId: "pg_pay" });
  });

  it("returns the paywall page id for an explicit goto by id", () => {
    const testPages: PageGraph = new Map([
      ["pg_info", { id: "pg_info", type: "info", config: {}, default_next: "pg_pay" }],
      ["pg_other", { id: "pg_other", type: "info", config: {} }],
      ["pg_pay", { id: "pg_pay", type: "paywall", config: {} }],
    ]);
    expect(
      evaluateNext({
        page: { id: "pg_info", type: "info", config: {}, default_next: "pg_pay" },
        pagesOrder: ["pg_info", "pg_other", "pg_pay"],
        answers: new Map(),
        pagesById: testPages,
      }),
    ).toEqual({ next: "page", pageId: "pg_pay" });
  });

  it("resolves the literal `paywall` goto to the funnel's paywall page", () => {
    const testPages: PageGraph = new Map([
      ["pg_info", { id: "pg_info", type: "info", config: {}, default_next: "paywall" }],
      ["pg_pay", { id: "pg_pay", type: "paywall", config: {} }],
    ]);
    expect(
      evaluateNext({
        page: { id: "pg_info", type: "info", config: {}, default_next: "paywall" },
        pagesOrder: ["pg_info", "pg_pay"],
        answers: new Map(),
        pagesById: testPages,
      }),
    ).toEqual({ next: "page", pageId: "pg_pay" });
  });

  it("keeps the id-less form only when the funnel has no paywall page", () => {
    const testPages: PageGraph = new Map([
      ["pg_info", { id: "pg_info", type: "info", config: {}, default_next: "paywall" }],
    ]);
    expect(
      evaluateNext({
        page: { id: "pg_info", type: "info", config: {}, default_next: "paywall" },
        pagesOrder: ["pg_info"],
        answers: new Map(),
        pagesById: testPages,
      }),
    ).toEqual({ next: "paywall" });
  });
});
