import { describe, expect, it } from "vitest";
import { utcToday } from "../src/routes/public/funnels";
import { evaluateNext, shiftIsoDays, type AnswerMap } from "@rovenue/shared/funnel";

// =============================================================
// The server is the ONE authority for "today"
// =============================================================
//
// Real routing is server-side only — funnel-runner.tsx never calls
// evaluateNext — so a relative date rule is decided here or nowhere. This
// programme has already shipped two "built but unwired" features, so the
// injection gets its own test rather than being taken on trust.

describe("utcToday", () => {
  it("formats a UTC calendar date, zero-padded", () => {
    // Zero-padding is load-bearing: the operators compare ISO text, and an
    // unpadded month would sort wrongly.
    expect(utcToday(new Date("2026-03-01T12:00:00Z"))).toBe("2026-03-01");
    expect(utcToday(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-31");
  });

  it("uses UTC, not the host's local zone — the documented trade-off", () => {
    // 2026-07-26T23:30Z is already the 26th in UTC while being the 26th or
    // 27th locally depending on the runner's zone. Asserting the UTC value
    // pins the choice rather than inheriting the CI machine's timezone.
    expect(utcToday(new Date("2026-07-26T23:30:00Z"))).toBe("2026-07-26");
    expect(utcToday(new Date("2026-07-27T00:30:00Z"))).toBe("2026-07-27");
  });

  it("produces a value the relative operators actually accept", () => {
    // The seam that matters: a correctly-shaped date that the evaluator
    // still refused would leave every relative rule silently dead.
    const today = utcToday(new Date("2026-07-26T10:00:00Z"));
    const answers: AnswerMap = new Map([["q_d", shiftIsoDays(today, -5)!]]);
    const res = evaluateNext({
      page: {
        id: "pg_1",
        type: "date_input",
        next_rules: [
          {
            id: "r_1",
            condition: {
              op: "all",
              clauses: [{ question_id: "q_d", op: "within_last_days", value: 30 } as never],
            },
            goto: "pg_hit",
          },
        ],
        default_next: "pg_miss",
      },
      pagesOrder: ["pg_1", "pg_hit", "pg_miss"],
      answers,
      pagesById: new Map([
        ["pg_1", { id: "pg_1", type: "date_input" }],
        ["pg_hit", { id: "pg_hit", type: "info" }],
        ["pg_miss", { id: "pg_miss", type: "info" }],
      ]),
      today,
    });
    expect(res).toEqual({ next: "page", pageId: "pg_hit" });
  });
});
