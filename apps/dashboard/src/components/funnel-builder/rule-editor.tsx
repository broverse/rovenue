import { Fragment } from "react";
import { component, useService } from "impair";
import { createId } from "@paralleldrive/cuid2";
import { ArrowRight, Plus, Trash2, TriangleAlert } from "lucide-react";
import type { Clause, ClauseOp, NextRule } from "@rovenue/shared/funnel";
import { cn } from "../../lib/cn";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";
import { OPERATORS_BY_KIND, PAGE_TYPES, type AnswerKind } from "./types";

const NUMERIC_COMPARISONS: ReadonlySet<ClauseOp> = new Set(["gt", "gte", "lt", "lte"]);

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

/**
 * Store an operand in the type `evalClause` will compare it with.
 *
 * `gt`/`gte`/`lt`/`lte` require `typeof clause.value === "number"`. So do
 * `eq`/`neq` when the question answers with a number, because evalClause
 * compares with `===` and `5 === "5"` is false — without this, `eq` on a
 * numeric question is dead and `neq` fires for EVERY visitor.
 * (`between` coerces its own pair separately.)
 *
 * Applied on BLUR, not on every keystroke. Coercing as the author types
 * makes `1.5` untypeable (`"1."` → `Number` → `1` → re-rendered as `"1"`,
 * so the `.` can never be followed), turns a cleared box into `0`, and
 * turns `"-"` into `NaN` — which JSON-serialises to `null`, passes the
 * schema's value-present check, and then never matches. Leaving the field
 * is the moment the value is finished, so that is when it is typed.
 *
 * A string that is not a number is left alone rather than becoming `NaN`.
 */
export function coerceOperandValue(
  op: ClauseOp,
  raw: string,
  kind: AnswerKind = "text",
): string | number {
  const needsNumber =
    NUMERIC_COMPARISONS.has(op) || (kind === "number" && (op === "eq" || op === "neq"));
  if (!needsNumber) return raw;
  const n = Number(raw);
  return raw.trim() === "" || Number.isNaN(n) ? raw : n;
}

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
  const earlierQs = vm.pages
    .slice(0, myIdx)
    .map((p) => p.question_id)
    .filter((q): q is string => Boolean(q));

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
              const answerKind = questionPage ? PAGE_TYPES[questionPage.type].answerKind : "none";
              const allowedOps = OPERATORS_BY_KIND[answerKind];
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
                        const nextKind = nextPage ? PAGE_TYPES[nextPage.type].answerKind : "none";
                        const nextAllowed = OPERATORS_BY_KIND[nextKind];
                        // Without clamping, an operator the new question
                        // does not allow stays in the clause while the
                        // <select> — having no matching <option> — shows
                        // the first one. Displayed and saved diverge.
                        const nextOp = nextAllowed.includes(c.op) ? c.op : nextAllowed[0];
                        updateClause(ruleIdx, clauseIdx, {
                          question_id: nextQuestionId,
                          ...(nextOp === undefined
                            ? {}
                            : { op: nextOp, value: defaultOperand(nextOp) }),
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
                            const next: [number, number] = [
                              Number(e.currentTarget.value),
                              Number(value[1] ?? 0),
                            ];
                            updateClause(ruleIdx, clauseIdx, { value: next } as Partial<Clause>);
                          }}
                          className="h-6 w-12 rounded border border-rv-divider bg-rv-c1 px-1.5 font-rv-mono text-[11px] text-foreground outline-none focus:border-rv-accent-500"
                        />
                        <span className="text-[10px] text-rv-mute-500">—</span>
                        <input
                          value={String(value[1] ?? "")}
                          onChange={(e) => {
                            const next: [number, number] = [
                              Number(value[0] ?? 0),
                              Number(e.currentTarget.value),
                            ];
                            updateClause(ruleIdx, clauseIdx, { value: next } as Partial<Clause>);
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
