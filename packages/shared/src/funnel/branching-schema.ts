import { z } from "zod";

export const CLAUSE_OPS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "in",
  "not_in",
  "contains",
  "not_contains",
  "before",
  "after",
  "on_or_before",
  "on_or_after",
  "is_answered",
  "is_not_answered",
] as const;

export type ClauseOp = (typeof CLAUSE_OPS)[number];

/**
 * An ISO-8601 calendar date, zero-padded: `YYYY-MM-DD`.
 *
 * Load-bearing, not cosmetic. The date operators compare lexicographically
 * because that equals chronological order for THIS format — and only for
 * this format. `"2026-1-5"` sorts after `"2026-01-10"` as text while being
 * earlier as a date, so comparing unvalidated input silently routes to the
 * wrong branch. Both the answer and the operand are checked against this
 * before any date operator compares them.
 *
 * Calendar validity is deliberately not enforced: `2026-02-31` compares
 * consistently and harmlessly, and a regex that also policed month lengths
 * would be a liability for no gain.
 */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const clauseSchema = z
  .object({
    question_id: z.string().min(1),
    op: z.enum(CLAUSE_OPS),
    value: z.unknown().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.op === "is_answered" || c.op === "is_not_answered") {
      if (c.value !== undefined) {
        ctx.addIssue({ code: "custom", message: `Op ${c.op} accepts no value`, path: ["value"] });
      }
      return;
    }
    if (c.value === undefined) {
      ctx.addIssue({ code: "custom", message: `Op ${c.op} requires value`, path: ["value"] });
      return;
    }
    if (c.op === "in" || c.op === "not_in") {
      if (!Array.isArray(c.value)) {
        ctx.addIssue({ code: "custom", message: `Op ${c.op} requires array value`, path: ["value"] });
      }
    }
    if (c.op === "contains" || c.op === "not_contains") {
      // The evaluator compares against a string member of a string[]
      // answer, so a non-string operand validates here and then silently
      // never fires. Reject it at the boundary instead.
      if (typeof c.value !== "string") {
        ctx.addIssue({
          code: "custom",
          message: `Op ${c.op} requires a string value`,
          path: ["value"],
        });
      }
    }
    if (c.op === "gt" || c.op === "gte" || c.op === "lt" || c.op === "lte") {
      // evaluator.ts requires `typeof clause.value === "number"` for these
      // four — the same reasoning as the contains/not_contains guard
      // above: a numeric-looking string validates here and then silently
      // never fires. Reject it at the boundary instead.
      if (typeof c.value !== "number") {
        ctx.addIssue({
          code: "custom",
          message: `Op ${c.op} requires a number value`,
          path: ["value"],
        });
      }
    }
    if (c.op === "between") {
      if (!Array.isArray(c.value) || c.value.length !== 2) {
        ctx.addIssue({
          code: "custom",
          message: `Op between requires [min, max]`,
          path: ["value"],
        });
      } else if (typeof c.value[0] !== "number" || typeof c.value[1] !== "number") {
        // `[null, null]` — what a NaN bound JSON-serialises to — passes
        // the length-2 check above and then never matches in evalClause.
        ctx.addIssue({
          code: "custom",
          message: `Op between requires [min, max] as numbers`,
          path: ["value"],
        });
      }
    }
    if (
      c.op === "before" ||
      c.op === "after" ||
      c.op === "on_or_before" ||
      c.op === "on_or_after"
    ) {
      // evalClause compares these as TEXT, which equals chronological
      // order only for zero-padded YYYY-MM-DD. An unpadded or otherwise
      // off-format operand would validate here and then compare in the
      // wrong direction — worse than never firing. Reject it at the
      // boundary, the same reasoning as the contains and numeric guards.
      if (typeof c.value !== "string" || !ISO_DATE_RE.test(c.value)) {
        ctx.addIssue({
          code: "custom",
          message: `Op ${c.op} requires an ISO date (YYYY-MM-DD)`,
          path: ["value"],
        });
      }
    }
  });

export type Clause = z.infer<typeof clauseSchema>;

export const nextRuleSchema = z.object({
  id: z.string().min(1),
  condition: z.object({
    op: z.enum(["all", "any"]),
    clauses: z.array(clauseSchema).min(1),
  }),
  goto: z.union([z.string().min(1), z.literal("paywall"), z.literal("end")]),
});

export type NextRule = z.infer<typeof nextRuleSchema>;
