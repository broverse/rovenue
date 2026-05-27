import type { Clause, NextRule } from "./branching-schema";

export type AnswerValue = string | number | boolean | string[] | null;
export type AnswerMap = Map<string, AnswerValue>;

export interface EvalPage {
  id: string;
  type: string;
  config: Record<string, unknown>;
  next_rules?: NextRule[];
  default_next?: string | "paywall" | "end";
}

export type PageGraph = Map<string, EvalPage>;

export type EvalResult =
  | { next: "page"; pageId: string }
  | { next: "paywall" }
  | { next: "end" };

interface EvalInput {
  page: EvalPage;
  pagesOrder: string[];
  answers: AnswerMap;
  pagesById: PageGraph;
}

export function evaluateNext(input: EvalInput): EvalResult {
  const { page, answers, pagesOrder, pagesById } = input;
  const rules = page.next_rules ?? [];
  for (const rule of rules) {
    if (matches(rule.condition, answers)) {
      return resolveGoto(rule.goto, page.id, pagesOrder, pagesById);
    }
  }
  if (page.default_next !== undefined) {
    return resolveGoto(page.default_next, page.id, pagesOrder, pagesById);
  }
  return resolveGoto("sequential", page.id, pagesOrder, pagesById);
}

function resolveGoto(
  goto: string | "paywall" | "end" | "sequential",
  fromId: string,
  pagesOrder: string[],
  pagesById: PageGraph,
): EvalResult {
  if (goto === "paywall") return { next: "paywall" };
  if (goto === "end") return { next: "end" };
  if (goto === "sequential") {
    const idx = pagesOrder.indexOf(fromId);
    if (idx === -1 || idx === pagesOrder.length - 1) return { next: "end" };
    const nextId = pagesOrder[idx + 1];
    if (pagesById.get(nextId)?.type === "paywall") return { next: "paywall" };
    return { next: "page", pageId: nextId };
  }
  if (pagesById.get(goto)?.type === "paywall") return { next: "paywall" };
  return { next: "page", pageId: goto };
}

function matches(
  condition: { op: "all" | "any"; clauses: Clause[] },
  answers: AnswerMap,
): boolean {
  if (condition.op === "all") {
    return condition.clauses.every((c) => evalClause(c, answers));
  }
  return condition.clauses.some((c) => evalClause(c, answers));
}

function evalClause(clause: Clause, answers: AnswerMap): boolean {
  const a = answers.get(clause.question_id);
  switch (clause.op) {
    case "is_answered":
      return a !== undefined && a !== null;
    case "is_not_answered":
      return a === undefined || a === null;
    case "eq":
      return a === clause.value;
    case "neq":
      return a !== clause.value;
    case "gt":
      return typeof a === "number" && typeof clause.value === "number" && a > clause.value;
    case "gte":
      return typeof a === "number" && typeof clause.value === "number" && a >= clause.value;
    case "lt":
      return typeof a === "number" && typeof clause.value === "number" && a < clause.value;
    case "lte":
      return typeof a === "number" && typeof clause.value === "number" && a <= clause.value;
    case "between": {
      if (typeof a !== "number" || !Array.isArray(clause.value) || clause.value.length !== 2) {
        return false;
      }
      const [min, max] = clause.value as [number, number];
      return a >= min && a <= max;
    }
    case "in":
      return Array.isArray(clause.value) && (clause.value as unknown[]).includes(a);
    case "not_in":
      return Array.isArray(clause.value) && !(clause.value as unknown[]).includes(a);
    case "contains":
      return Array.isArray(a) && typeof clause.value === "string" && a.includes(clause.value);
    default:
      return false;
  }
}
