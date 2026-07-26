import { describe, expect, it } from "vitest";
import { evaluateNext, type AnswerMap, type AnswerValue } from "./evaluator";
import { pagesArraySchema } from "./pages-schema";
import type { ClauseOp } from "./branching-schema";

// =============================================================
// Addressing a contact_info sub-field: `<question_id>.<field>`
// =============================================================
//
// `.` is reservable as the separator because a generated question id can
// never contain one: qid() is `${prefix}_${cuid2.slice(0,6)}` and cuid2 is
// base36. The only way a dot could reach a real id is hand- or API-authored
// JSON, which pages-schema now rejects — so the grammar is unambiguous by
// construction rather than by convention.

function fires(
  questionId: string,
  op: ClauseOp,
  stored: Record<string, AnswerValue>,
  value?: unknown,
): boolean {
  const answers: AnswerMap = new Map(Object.entries(stored));
  const res = evaluateNext({
    page: {
      id: "pg_1",
      type: "contact_info",
      next_rules: [
        {
          id: "r_1",
          condition: { op: "all", clauses: [{ question_id: questionId, op, value } as never] },
          goto: "pg_hit",
        },
      ],
      default_next: "pg_miss",
    },
    pagesOrder: ["pg_1", "pg_hit", "pg_miss"],
    answers,
    pagesById: new Map([
      ["pg_1", { id: "pg_1", type: "contact_info" }],
      ["pg_hit", { id: "pg_hit", type: "info" }],
      ["pg_miss", { id: "pg_miss", type: "info" }],
    ]),
  });
  return res.next === "page" && res.pageId === "pg_hit";
}

const CONTACT = { q_c: { name: "Ada", email: "ada@x.co" } as AnswerValue };

describe("resolving a sub-field", () => {
  it("reads the named field out of the composite", () => {
    expect(fires("q_c.email", "eq", CONTACT, "ada@x.co")).toBe(true);
    expect(fires("q_c.name", "eq", CONTACT, "Ada")).toBe(true);
    expect(fires("q_c.email", "eq", CONTACT, "someone@else.co")).toBe(false);
  });

  it("treats a field the page did not ask for as unanswered", () => {
    // `phone` has no key at all here — the page never asked for it.
    expect(fires("q_c.phone", "is_answered", CONTACT)).toBe(false);
    expect(fires("q_c.phone", "is_not_answered", CONTACT)).toBe(true);
  });

  it("treats an asked-for-but-blank field as unanswered", () => {
    const blank = { q_c: { name: "Ada", email: "" } as AnswerValue };
    expect(fires("q_c.email", "is_answered", blank)).toBe(false);
    expect(fires("q_c.name", "is_answered", blank)).toBe(true);
  });

  it("resolves an unknown field NAME to unanswered rather than throwing", () => {
    expect(() => fires("q_c.nope", "is_answered", CONTACT)).not.toThrow();
    expect(fires("q_c.nope", "is_answered", CONTACT)).toBe(false);
  });

  it("resolves to unanswered when the base is not a composite", () => {
    // Must not crash, and must not index into a string — "abc".email is
    // undefined in JS, but relying on that is how a silent wrong answer
    // ships.
    const text = { q_t: "abc" as AnswerValue };
    expect(fires("q_t.email", "is_answered", text)).toBe(false);
    expect(fires("q_t.email", "eq", text, "abc")).toBe(false);
  });

  it("resolves to unanswered when the base id does not exist", () => {
    expect(fires("q_missing.email", "is_answered", CONTACT)).toBe(false);
  });

  it("resolves a multi-dot id to unanswered rather than throwing", () => {
    // NOTE, from mutation-checking: this does NOT distinguish first-dot from
    // last-dot splitting. Switching indexOf to lastIndexOf reds nothing,
    // because valid field names are single words and a page id cannot contain
    // a dot — so with one dot the two are identical, and with two dots both
    // fail to resolve (first-dot gets an invalid field, last-dot gets a
    // missing base). The choice is observationally equivalent; what is worth
    // pinning is that a malformed id degrades to unanswered instead of
    // throwing or matching something.
    expect(() => fires("q_c.email.x", "is_answered", CONTACT)).not.toThrow();
    expect(fires("q_c.email.x", "is_answered", CONTACT)).toBe(false);
  });

  it("leaves a plain question id working exactly as before", () => {
    expect(fires("q_c", "is_answered", CONTACT)).toBe(true);
    const partial = { q_c: { name: "Ada", email: "" } as AnswerValue };
    // The composite's is_answered still means EVERY asked-for field — the
    // narrower sub-field version arriving alongside it is exactly when the
    // two could be conflated.
    expect(fires("q_c", "is_answered", partial)).toBe(false);
  });
});

describe("text operators fire on a resolved sub-field", () => {
  it("supports eq / neq / in / not_in", () => {
    expect(fires("q_c.email", "neq", CONTACT, "other@x.co")).toBe(true);
    expect(fires("q_c.email", "in", CONTACT, ["ada@x.co", "b@x.co"])).toBe(true);
    expect(fires("q_c.email", "not_in", CONTACT, ["b@x.co"])).toBe(true);
    expect(fires("q_c.email", "in", CONTACT, ["b@x.co"])).toBe(false);
  });
});

describe("the dot reservation is enforced, not assumed", () => {
  function parse(questionId: string) {
    return pagesArraySchema.safeParse([
      { id: "pg_1", type: "short_text", question_id: questionId },
    ]);
  }

  it("accepts a normal generated question id", () => {
    expect(parse("q_ab12cd").success).toBe(true);
    expect(parse("legal_ab12cd").success).toBe(true);
  });

  it("rejects a page question_id containing a dot", () => {
    // Without this the reservation is a convention stored JSON can violate,
    // and a page id of `q.c` would make `q.c.email` ambiguous.
    expect(parse("q.c").success).toBe(false);
    expect(parse("a.b.c").success).toBe(false);
  });
});
