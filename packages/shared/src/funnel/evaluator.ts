import type { Clause, NextRule } from "./branching-schema";
import { ISO_DATE_RE } from "./branching-schema";

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

  // One definition of "answered", matching the runner's own gate: an
  // empty string and an empty selection are not answers. The evaluator
  // and the client disagreeing about this was two definitions one hop
  // apart.
  const answered =
    a !== undefined &&
    a !== null &&
    a !== "" &&
    !(Array.isArray(a) && a.length === 0);

  // A multi_choice answer is a string[]. Comparing it with a scalar
  // operator is a type mismatch, not a question with an answer — so the
  // scalar operators below refuse it in BOTH directions rather than
  // letting `neq`/`not_in` come back true by accident and route the
  // visitor somewhere nobody chose. Arrays have `contains` /
  // `not_contains` instead.
  const isArray = Array.isArray(a);

  switch (clause.op) {
    case "is_answered":
      return answered;
    case "is_not_answered":
      return !answered;
    case "eq":
      return !isArray && a === clause.value;
    case "neq":
      // NOTE: an UNANSWERED question still fires here, deliberately.
      // "they did not say x, including by skipping" is meaningful;
      // narrowing it would also make is_not_answered redundant.
      return !isArray && a !== clause.value;
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
      return !isArray && Array.isArray(clause.value) && (clause.value as unknown[]).includes(a);
    case "not_in":
      return !isArray && Array.isArray(clause.value) && !(clause.value as unknown[]).includes(a);
    case "contains":
      return isArray && typeof clause.value === "string" && (a as string[]).includes(clause.value);
    case "not_contains":
      return isArray && typeof clause.value === "string" && !(a as string[]).includes(clause.value);
    // ---- date operators ----
    //
    // Lexicographic comparison IS chronological comparison for zero-padded
    // YYYY-MM-DD, so these need no date parsing — and must not do any.
    // Parsing would attach a time and a zone to a value that has neither
    // (`new Date("2026-03-01")` is midnight UTC, i.e. the previous day west
    // of Greenwich).
    //
    // The guard is what makes that equivalence safe rather than merely
    // convenient: an unpadded "2026-1-5" sorts AFTER "2026-01-10" as text
    // while being EARLIER as a date. Either side failing the pattern means
    // the operator cannot compare, so it returns false rather than
    // answering true by accident.
    case "before":
    case "after":
    case "on_or_before":
    case "on_or_after": {
      if (
        typeof a !== "string" ||
        typeof clause.value !== "string" ||
        !ISO_DATE_RE.test(a) ||
        !ISO_DATE_RE.test(clause.value)
      ) {
        return false;
      }
      const other = clause.value;
      if (clause.op === "before") return a < other;
      if (clause.op === "after") return a > other;
      if (clause.op === "on_or_before") return a <= other;
      return a >= other;
    }
    default:
      return false;
  }
}
