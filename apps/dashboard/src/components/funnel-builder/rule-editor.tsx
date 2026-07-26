import { Fragment } from "react";
import { component, useService } from "impair";
import { createId } from "@paralleldrive/cuid2";
import { ArrowRight, Plus, Trash2, TriangleAlert } from "lucide-react";
import type { Clause, ClauseOp, NextRule } from "@rovenue/shared/funnel";
import { cn } from "../../lib/cn";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";
import { OPERATORS_BY_KIND, PAGE_TYPES, type AnswerKind, type Page } from "./types";
import { coerceOperandValue } from "./coerce-operand";

// Re-exported so existing imports (`import { coerceOperandValue } from
// "./rule-editor"`) keep working — the implementation moved to
// coerce-operand.ts so the view model can reuse it too without importing
// this component module (which imports FunnelDraftViewModel from the VM).
export { coerceOperandValue };

/** Safe lookup for `PAGE_TYPES[type].answerKind`. `Page.type` is typed
 * `PageType`, but the value originates in server JSON through `as never`
 * casts, so an unknown/legacy type must resolve to "none" (unbranchable)
 * rather than throw a runtime TypeError that takes down the rule editor. */
export function answerKindFor(type: string): AnswerKind {
  return (PAGE_TYPES as Record<string, { answerKind: AnswerKind } | undefined>)[type]?.answerKind ?? "none";
}

/** Question ids from pages before `uptoIdx` that can actually be branched
 * on. A page can carry a `question_id` despite having no comparable
 * answer — `contact_info` collects name/email/phone as a composite, not a
 * single value, so it is classified `answerKind: "none"` even though it
 * has a question id. Offering it here would let an author pick a question
 * for which `OPERATORS_BY_KIND` has nothing to offer, leaving a clause
 * with zero valid operators — the `<select>` for `op` would render no
 * `<option>`s at all. */
export function branchableQuestionIds(pages: Page[], uptoIdx: number): string[] {
  return pages
    .slice(0, uptoIdx)
    .filter(
      (p): p is Page & { question_id: string } =>
        Boolean(p.question_id) && answerKindFor(p.type) !== "none",
    )
    .map((p) => p.question_id);
}

/**
 * What shape of operand an operator takes. Used to reset a stale value
 * when the operator changes class — `eq` → `in` would otherwise leave a
 * scalar where an array is required, which validates nowhere and fails
 * at publish.
 */
export type OperandShape = "none" | "scalar" | "array" | "range";

/** A fresh operand of the right shape for `op`, used when an edit makes
 * the previous one meaningless. `undefined` for the unary operators,
 * which the schema forbids from carrying a value at all. */
export function defaultOperand(op: ClauseOp): unknown {
  switch (operandShape(op)) {
    case "none":
      return undefined;
    case "array":
      return [];
    case "range":
      return [0, 0];
    default:
      return "";
  }
}

export function operandShape(op: ClauseOp): OperandShape {
  if (op === "is_answered" || op === "is_not_answered") return "none";
  if (op === "in" || op === "not_in") return "array";
  if (op === "between") return "range";
  return "scalar";
}

/** Operators whose operand is a calendar date, so the row offers a date
 *  picker instead of free text — an author should not have to type a
 *  format they cannot see. */
const DATE_COMPARISONS: ReadonlySet<ClauseOp> = new Set([
  "before",
  "after",
  "on_or_before",
  "on_or_after",
]);

const OPERATORS: ReadonlyArray<{ v: ClauseOp; l: string }> = [
  { v: "eq", l: "equals" },
  { v: "neq", l: "≠" },
  { v: "gt", l: ">" },
  { v: "gte", l: "≥" },
  { v: "lt", l: "<" },
  { v: "lte", l: "≤" },
  { v: "between", l: "between" },
  { v: "in", l: "is one of" },
  { v: "not_in", l: "is not one of" },
  { v: "contains", l: "contains" },
  { v: "not_contains", l: "does not contain" },
  { v: "before", l: "is before" },
  { v: "after", l: "is after" },
  { v: "on_or_before", l: "is on or before" },
  { v: "on_or_after", l: "is on or after" },
  { v: "within_last_days", l: "in the last N days" },
  { v: "more_than_days_ago", l: "more than N days ago" },
  { v: "is_answered", l: "is answered" },
  { v: "is_not_answered", l: "is not answered" },
];

/** Operators the clause row can actually render. Exported so a test can
 * prove every operator OPERATORS_BY_KIND offers has a label here — the
 * two tables drifting is how `not_contains` shipped unselectable. */
export const RENDERABLE_OPS: ReadonlySet<ClauseOp> = new Set(OPERATORS.map((o) => o.v));

interface Props {
  pageId: string;
}

export const RuleEditor = component(({ pageId }: Props) => {
  const vm = useService(FunnelDraftViewModel);
  const rules = vm.rules[pageId] ?? [];
  const myIdx = vm.pages.findIndex((p) => p.id === pageId);
  const earlierQs = branchableQuestionIds(vm.pages, myIdx);

  const addRule = () => {
    const newRule: NextRule = {
      id: createId().slice(0, 8),
      condition: {
        op: "all",
        clauses: [
          { question_id: earlierQs[0] ?? "", op: "eq", value: "" } as Clause,
        ],
      },
      goto: "end",
    };
    vm.addRule(pageId, newRule);
  };

  const addClause = (ruleIdx: number) => {
    const rule = rules[ruleIdx];
    if (!rule) return;
    const next: NextRule = {
      ...rule,
      condition: {
        ...rule.condition,
        clauses: [
          ...rule.condition.clauses,
          { question_id: earlierQs[0] ?? "", op: "eq", value: "" } as Clause,
        ],
      },
    };
    vm.updateRule(pageId, ruleIdx, next);
  };

  const updateClause = (ruleIdx: number, clauseIdx: number, patch: Partial<Clause>) => {
    const rule = rules[ruleIdx];
    if (!rule) return;
    const nextClauses = rule.condition.clauses.slice();
    nextClauses[clauseIdx] = { ...nextClauses[clauseIdx], ...patch } as Clause;
    vm.updateRule(pageId, ruleIdx, {
      ...rule,
      condition: { ...rule.condition, clauses: nextClauses },
    });
  };

  // A clause whose question resolves to zero valid operators (see
  // branchableQuestionIds) cannot be displayed or saved meaningfully —
  // drop it rather than leave a stale operator the <select> renders no
  // <option> for. Falls back to removing the whole rule when it was the
  // clause's last one, matching removeRule's own empty-list handling.
  const removeClause = (ruleIdx: number, clauseIdx: number) => {
    const rule = rules[ruleIdx];
    if (!rule) return;
    if (rule.condition.clauses.length <= 1) {
      vm.removeRule(pageId, ruleIdx);
      return;
    }
    const nextClauses = rule.condition.clauses.filter((_, i) => i !== clauseIdx);
    vm.updateRule(pageId, ruleIdx, {
      ...rule,
      condition: { ...rule.condition, clauses: nextClauses },
    });
  };

  const toggleCombinator = (ruleIdx: number) => {
    const rule = rules[ruleIdx];
    if (!rule) return;
    const nextOp = rule.condition.op === "all" ? "any" : "all";
    vm.updateRule(pageId, ruleIdx, {
      ...rule,
      condition: { ...rule.condition, op: nextOp },
    });
  };

  return (
    <>
      {rules.map((rule, ruleIdx) => {
        const targetPage = vm.pages.find((p) => p.id === rule.goto);
        const broken = !targetPage && rule.goto !== "paywall" && rule.goto !== "end";
        return (
          <div
            key={rule.id}
            className={cn(
              "mt-2.5 rounded-md border bg-rv-c2 p-2.5",
              broken ? "border-rv-danger/40 bg-rv-danger/[0.04]" : "border-rv-divider",
            )}
          >
            <div className="mb-2 flex items-center gap-2">
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-rv-accent-500/20 px-1 font-rv-mono text-[9px] font-bold text-rv-accent-500">
                {ruleIdx + 1}
              </span>
              <button
                type="button"
                onClick={() => toggleCombinator(ruleIdx)}
                className="text-[10px] font-semibold uppercase tracking-wider text-rv-mute-500 hover:text-foreground"
              >
                Rule · {rule.condition.op === "all" ? "all match" : "any match"}
              </button>
              <button
                type="button"
                title="Delete rule"
                onClick={() => vm.removeRule(pageId, ruleIdx)}
                className="ml-auto flex h-5 w-5 cursor-pointer items-center justify-center rounded text-rv-mute-500 transition hover:bg-rv-c3 hover:text-rv-danger"
              >
                <Trash2 size={11} />
              </button>
            </div>

            {rule.condition.clauses.map((c, clauseIdx) => {
              const isRange = c.op === "between";
              const isArr = c.op === "in" || c.op === "not_in";
              const isUnary = c.op === "is_answered" || c.op === "is_not_answered";
              const value = "value" in c ? c.value : undefined;
              // The clause's question, not the page being edited — the
              // operators offered depend on what the ANSWER looks like.
              const questionPage = vm.pages.find((p) => p.question_id === c.question_id);
              const answerKind = questionPage ? answerKindFor(questionPage.type) : "none";
              const allowedOps = OPERATORS_BY_KIND[answerKind];

              // A clause authored before branchableQuestionIds excluded
              // "none"-kind questions (or one referencing a page that's
              // since been deleted) resolves here with zero valid
              // operators. Rendering the normal controls would put a
              // stored `question_id` into a <select> whose options
              // (earlierQs) no longer include it — the browser silently
              // displays some other option while state still holds the
              // real value, and the operator <select> gets zero
              // <option>s. That is displayed-diverges-from-saved, which
              // SP5 exists to remove. Render an explicit, visible broken
              // row instead: nothing about the clause changes until the
              // author acts on it.
              if (allowedOps.length === 0) {
                return (
                  <Fragment key={clauseIdx}>
                    {clauseIdx > 0 && (
                      <div className="my-1.5 text-center font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-500">
                        {rule.condition.op}
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 rounded border border-rv-danger/30 bg-rv-danger/[0.05] px-2 py-1">
                      <TriangleAlert size={11} className="flex-shrink-0 text-rv-danger" />
                      <span className="flex-1 text-[11px] text-rv-danger">
                        References an unavailable question (
                        {c.question_id || "no question set"}) and cannot fire.
                      </span>
                      <button
                        type="button"
                        title="Remove unavailable clause"
                        onClick={() => removeClause(ruleIdx, clauseIdx)}
                        className="flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center rounded text-rv-danger transition hover:bg-rv-c3"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </Fragment>
                );
              }

              return (
                <Fragment key={clauseIdx}>
                  {clauseIdx > 0 && (
                    <div className="my-1.5 text-center font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-500">
                      {rule.condition.op}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <select
                      value={c.question_id}
                      onChange={(e) => {
                        const nextQuestionId = e.currentTarget.value;
                        const nextPage = vm.pages.find((p) => p.question_id === nextQuestionId);
                        const nextKind = nextPage ? answerKindFor(nextPage.type) : "none";
                        const nextAllowed = OPERATORS_BY_KIND[nextKind];
                        // earlierQs (branchableQuestionIds) already excludes
                        // "none"-kind questions, so nextAllowed is never
                        // empty for anything this <select> can offer.
                        // nextOp therefore always resolves — this guard is
                        // a defensive fallback, not the primary fix, for
                        // if that invariant is ever broken.
                        if (nextAllowed.length === 0) {
                          removeClause(ruleIdx, clauseIdx);
                          return;
                        }
                        // Without clamping, an operator the new question
                        // does not allow stays in the clause while the
                        // <select> — having no matching <option> — shows
                        // the first one. Displayed and saved diverge.
                        const nextOp = nextAllowed.includes(c.op) ? c.op : nextAllowed[0];
                        updateClause(ruleIdx, clauseIdx, {
                          question_id: nextQuestionId,
                          op: nextOp,
                          value: defaultOperand(nextOp),
                        } as Partial<Clause>);
                      }}
                      className="h-6 max-w-[110px] rounded border border-rv-divider bg-rv-c1 px-1.5 font-rv-mono text-[11px] text-rv-accent-500 outline-none focus:border-rv-accent-500"
                    >
                      {earlierQs.map((q) => (
                        <option key={q} value={q}>
                          {q}
                        </option>
                      ))}
                    </select>
                    <select
                      value={c.op}
                      onChange={(e) => {
                        const nextOp = e.currentTarget.value as ClauseOp;
                        // A stale operand of the wrong shape survives an
                        // operator change otherwise: eq -> in leaves a
                        // scalar where an array is required, and eq -> gt
                        // leaves a string that can never match.
                        const patch: Partial<Clause> =
                          operandShape(nextOp) === operandShape(c.op)
                            ? ({ op: nextOp } as Partial<Clause>)
                            : ({ op: nextOp, value: defaultOperand(nextOp) } as Partial<Clause>);
                        updateClause(ruleIdx, clauseIdx, patch);
                      }}
                      className="h-6 rounded border border-rv-divider bg-rv-c1 px-1.5 text-[11px] text-rv-mute-700 outline-none focus:border-rv-accent-500"
                    >
                      {OPERATORS.filter((o) => allowedOps.includes(o.v)).map((o) => (
                        <option key={o.v} value={o.v}>
                          {o.l}
                        </option>
                      ))}
                    </select>
                    {!isRange && !isArr && !isUnary && (
                      <input
                        type={DATE_COMPARISONS.has(c.op) ? "date" : "text"}
                        value={value === undefined ? "" : String(value)}
                        onChange={(e) =>
                          updateClause(ruleIdx, clauseIdx, {
                            // Raw while typing — see coerceOperandValue.
                            value: e.currentTarget.value as never,
                          } as Partial<Clause>)
                        }
                        onBlur={(e) =>
                          updateClause(ruleIdx, clauseIdx, {
                            value: coerceOperandValue(
                              c.op,
                              e.currentTarget.value,
                              answerKind,
                            ) as never,
                          } as Partial<Clause>)
                        }
                        className="h-6 max-w-[110px] flex-1 rounded border border-rv-divider bg-rv-c1 px-1.5 font-rv-mono text-[11px] text-foreground outline-none focus:border-rv-accent-500"
                      />
                    )}
                    {isRange && Array.isArray(value) && (
                      <>
                        <input
                          value={String(value[0] ?? "")}
                          onChange={(e) => {
                            // Raw while typing — see coerceOperandValue.
                            // Number() on every keystroke made "1.5"
                            // untypeable ("1." -> 1 -> re-rendered "1",
                            // the "." can never be followed) and turned a
                            // cleared box into 0.
                            const next = [e.currentTarget.value, value[1] ?? 0];
                            updateClause(ruleIdx, clauseIdx, { value: next as never } as Partial<Clause>);
                          }}
                          onBlur={(e) => {
                            const next = [
                              coerceOperandValue("between", e.currentTarget.value, answerKind),
                              value[1] ?? 0,
                            ];
                            updateClause(ruleIdx, clauseIdx, { value: next as never } as Partial<Clause>);
                          }}
                          className="h-6 w-12 rounded border border-rv-divider bg-rv-c1 px-1.5 font-rv-mono text-[11px] text-foreground outline-none focus:border-rv-accent-500"
                        />
                        <span className="text-[10px] text-rv-mute-500">—</span>
                        <input
                          value={String(value[1] ?? "")}
                          onChange={(e) => {
                            const next = [value[0] ?? 0, e.currentTarget.value];
                            updateClause(ruleIdx, clauseIdx, { value: next as never } as Partial<Clause>);
                          }}
                          onBlur={(e) => {
                            const next = [
                              value[0] ?? 0,
                              coerceOperandValue("between", e.currentTarget.value, answerKind),
                            ];
                            updateClause(ruleIdx, clauseIdx, { value: next as never } as Partial<Clause>);
                          }}
                          className="h-6 w-12 rounded border border-rv-divider bg-rv-c1 px-1.5 font-rv-mono text-[11px] text-foreground outline-none focus:border-rv-accent-500"
                        />
                      </>
                    )}
                    {isArr && (
                      <input
                        value={Array.isArray(value) ? value.join(",") : ""}
                        onChange={(e) => {
                          const next = e.currentTarget.value
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean);
                          updateClause(ruleIdx, clauseIdx, { value: next as never } as Partial<Clause>);
                        }}
                        className="h-6 max-w-[140px] flex-1 rounded border border-rv-divider bg-rv-c1 px-1.5 font-rv-mono text-[11px] text-foreground outline-none focus:border-rv-accent-500"
                      />
                    )}
                  </div>
                </Fragment>
              );
            })}

            <button
              type="button"
              onClick={() => addClause(ruleIdx)}
              className="mt-2 inline-flex h-6 cursor-pointer items-center gap-1 rounded px-1.5 text-[11px] text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground"
            >
              <Plus size={10} /> Add clause
            </button>

            <div className="mt-2 flex items-center gap-2 rounded bg-rv-c1 px-2 py-1.5 text-[11px] text-rv-mute-600">
              <span>then</span>
              <ArrowRight size={11} className="text-rv-mute-500" />
              <select
                value={rule.goto}
                onChange={(e) =>
                  vm.updateRule(pageId, ruleIdx, { ...rule, goto: e.currentTarget.value })
                }
                className={cn(
                  "h-6 rounded border border-rv-divider bg-rv-c2 px-1.5 font-rv-mono text-[11px] outline-none focus:border-rv-accent-500",
                  broken ? "text-rv-danger" : "text-foreground",
                )}
              >
                {vm.pages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                  </option>
                ))}
                <option value="paywall">⟶ paywall</option>
                <option value="end">⟶ end</option>
                {broken && <option value={rule.goto}>{rule.goto} (broken)</option>}
              </select>
            </div>

            {broken && (
              <div className="mt-2 flex items-start gap-1.5 text-[11px] text-rv-danger">
                <TriangleAlert size={11} className="mt-0.5 flex-shrink-0" />
                <div>Target page no longer exists. Pick a valid page or remove the rule.</div>
              </div>
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={addRule}
        className="mt-2.5 inline-flex h-7 w-full cursor-pointer items-center justify-center gap-1.5 rounded border border-dashed border-rv-divider bg-rv-c2 px-2 text-[11px] text-rv-mute-600 transition hover:border-rv-accent-500 hover:text-rv-accent-500"
      >
        <Plus size={11} />
        Add rule
      </button>
    </>
  );
});
