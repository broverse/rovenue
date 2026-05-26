import type { Page } from "@rovenue/shared/funnel";

export type ValidatorIssue =
  | { code: "MISSING_PAYWALL"; message: string }
  | { code: "MISSING_SUCCESS"; message: string }
  | { code: "CYCLE"; message: string; path: string[] }
  | { code: "DUPLICATE_QUESTION_ID"; message: string; questionId: string }
  | { code: "UNKNOWN_QUESTION_REF"; message: string; pageId: string; questionId: string }
  | { code: "UNKNOWN_GOTO"; message: string; pageId: string; goto: string }
  | { code: "UNREACHABLE"; message: string; pageId: string };

export type ValidationResult =
  | { ok: true; warnings: ValidatorIssue[] }
  | { ok: false; issues: ValidatorIssue[]; warnings: ValidatorIssue[] };

interface MinimalPage {
  id: string;
  type: string;
  config: Record<string, unknown>;
  next_rules?: Array<{
    id: string;
    condition: { op: "all" | "any"; clauses: Array<{ question_id: string }> };
    goto: string;
  }>;
  default_next?: string;
}

export function validateFunnelGraph(pages: Page[] | MinimalPage[]): ValidationResult {
  const errors: ValidatorIssue[] = [];
  const warnings: ValidatorIssue[] = [];
  const list = pages as MinimalPage[];

  if (!list.some((p) => p.type === "paywall")) {
    errors.push({ code: "MISSING_PAYWALL", message: "Funnel needs at least one paywall page" });
  }
  if (!list.some((p) => p.type === "success")) {
    errors.push({ code: "MISSING_SUCCESS", message: "Funnel needs at least one success page" });
  }

  const byId = new Map<string, MinimalPage>(list.map((p) => [p.id, p]));
  const questionIds = new Map<string, string>();
  for (const p of list) {
    const qid = (p.config as { question_id?: string }).question_id;
    if (qid !== undefined) {
      if (questionIds.has(qid)) {
        errors.push({
          code: "DUPLICATE_QUESTION_ID",
          message: `question_id '${qid}' used on multiple pages`,
          questionId: qid,
        });
      } else {
        questionIds.set(qid, p.id);
      }
    }
  }

  for (const p of list) {
    for (const rule of p.next_rules ?? []) {
      for (const clause of rule.condition.clauses) {
        if (!questionIds.has(clause.question_id)) {
          errors.push({
            code: "UNKNOWN_QUESTION_REF",
            message: `Rule on page ${p.id} references unknown question_id '${clause.question_id}'`,
            pageId: p.id,
            questionId: clause.question_id,
          });
        }
      }
      if (rule.goto !== "paywall" && rule.goto !== "end" && !byId.has(rule.goto)) {
        errors.push({
          code: "UNKNOWN_GOTO",
          message: `Rule ${rule.id} on page ${p.id} goes to unknown page ${rule.goto}`,
          pageId: p.id,
          goto: rule.goto,
        });
      }
    }
    if (
      p.default_next !== undefined &&
      p.default_next !== "paywall" &&
      p.default_next !== "end" &&
      !byId.has(p.default_next)
    ) {
      errors.push({
        code: "UNKNOWN_GOTO",
        message: `default_next on ${p.id} -> unknown ${p.default_next}`,
        pageId: p.id,
        goto: p.default_next,
      });
    }
  }

  if (list.length > 0) {
    const order = list.map((p) => p.id);
    const cycleErrors = detectCycles(list, byId, order);
    errors.push(...cycleErrors);
    const reachable = computeReachable(list, byId, order);
    for (const p of list) {
      if (!reachable.has(p.id)) {
        warnings.push({
          code: "UNREACHABLE",
          message: `Page ${p.id} is unreachable from start`,
          pageId: p.id,
        });
      }
    }
  }

  if (errors.length > 0) return { ok: false, issues: errors, warnings };
  return { ok: true, warnings };
}

function nextTargets(
  page: MinimalPage,
  pagesOrder: string[],
): Array<"paywall" | "end" | string> {
  const targets: Array<"paywall" | "end" | string> = [];
  for (const rule of page.next_rules ?? []) {
    targets.push(rule.goto as "paywall" | "end" | string);
  }
  if (page.default_next !== undefined) {
    targets.push(page.default_next as "paywall" | "end" | string);
  } else {
    const idx = pagesOrder.indexOf(page.id);
    if (idx >= 0 && idx < pagesOrder.length - 1) {
      targets.push(pagesOrder[idx + 1]);
    }
  }
  return targets;
}

function detectCycles(
  list: MinimalPage[],
  byId: Map<string, MinimalPage>,
  order: string[],
): ValidatorIssue[] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(list.map((p) => [p.id, WHITE]));
  const issues: ValidatorIssue[] = [];

  function dfs(id: string, stack: string[]): void {
    color.set(id, GRAY);
    const p = byId.get(id);
    if (!p) return;
    for (const target of nextTargets(p, order)) {
      if (target === "paywall" || target === "end") continue;
      const c = color.get(target);
      if (c === GRAY) {
        const cycleStart = stack.indexOf(target);
        const path = stack.slice(cycleStart).concat(target);
        issues.push({ code: "CYCLE", message: `Cycle: ${path.join(" -> ")}`, path });
      } else if (c === WHITE) {
        dfs(target, [...stack, target]);
      }
    }
    color.set(id, BLACK);
  }

  for (const p of list) {
    if (color.get(p.id) === WHITE) dfs(p.id, [p.id]);
  }
  return issues;
}

function computeReachable(
  list: MinimalPage[],
  byId: Map<string, MinimalPage>,
  order: string[],
): Set<string> {
  const reachable = new Set<string>();
  if (list.length === 0) return reachable;
  const start = list[0].id;
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const p = byId.get(id);
    if (!p) continue;
    for (const target of nextTargets(p, order)) {
      if (target === "paywall" || target === "end") continue;
      if (!reachable.has(target)) stack.push(target);
    }
  }
  return reachable;
}
