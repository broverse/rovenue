import type { Clause, NextRule } from "./branching-schema";

export type AnswerValue = string | number | boolean | string[] | null;
export type AnswerMap = Map<string, AnswerValue>;

// Minimal page shape the runtime evaluator needs. Matches the flat
// dashboard page (see pages-schema.ts) — only the routing fields are
// load-bearing here; everything else is opaque from the evaluator's
// perspective.
export interface EvalPage {
  id: string;
  type: string;
  next_rules?: NextRule[];
  default_next?: string | "paywall" | "end";
  // Vestigial — older callers / tests still pass a `config` bag from when
  // the schema was SDK-wrapped. The evaluator no longer reads it, but
  // accepting it keeps existing fixtures + dashboard's `toEvalPage`
  // helper working unchanged.
  config?: Record<string, unknown>;
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

// Resolve the literal "paywall" goto to an actual page id. The literal form
// carries no page id; a funnel may legally contain multiple paywall pages.
// To keep routing deterministic (same funnel always routes the same way), we
// pick the first paywall page in page order. Authors who want a specific paywall
// should target it by id instead of using the literal.
function firstPaywallId(
  pagesOrder: string[],
  pagesById: PageGraph,
): string | null {
  for (const id of pagesOrder) {
    if (pagesById.get(id)?.type === "paywall") return id;
  }
  return null;
}

function resolveGoto(
  goto: string | "paywall" | "end" | "sequential",
  fromId: string,
  pagesOrder: string[],
  pagesById: PageGraph,
): EvalResult {
  if (goto === "paywall") {
    // The literal goto names no page. Resolve it to the funnel's paywall
    // page so the session's currentPageId can actually move there; the
    // id-less form survives only for a funnel with no paywall page,
    // which the publish validator already rejects.
    const paywallId = firstPaywallId(pagesOrder, pagesById);
    return paywallId ? { next: "page", pageId: paywallId } : { next: "paywall" };
  }
  if (goto === "end") return { next: "end" };
  if (goto === "sequential") {
    const idx = pagesOrder.indexOf(fromId);
    if (idx === -1 || idx === pagesOrder.length - 1) return { next: "end" };
    // A paywall page is a page like any other — it has an id and the
    // client needs it to render the paywall.
    return { next: "page", pageId: pagesOrder[idx + 1] };
  }
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
