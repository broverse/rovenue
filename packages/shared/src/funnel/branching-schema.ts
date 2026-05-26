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
  "is_answered",
  "is_not_answered",
] as const;

export type ClauseOp = (typeof CLAUSE_OPS)[number];

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
    if (c.op === "between") {
      if (!Array.isArray(c.value) || c.value.length !== 2) {
        ctx.addIssue({
          code: "custom",
          message: `Op between requires [min, max]`,
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
