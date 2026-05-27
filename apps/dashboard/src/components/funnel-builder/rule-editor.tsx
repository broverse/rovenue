import { ArrowRight, Plus, Trash2, TriangleAlert } from "lucide-react";
import { Fragment } from "react";
import { cn } from "../../lib/cn";
import { OPERATORS, type Page, type Rule } from "./types";

type Props = {
  rule: Rule;
  idx: number;
  pageId: string;
  allPages: Page[];
};

/**
 * Editor for a single branching rule. Used inline in the Properties
 * panel (per-page) and on the Workflow tab (cross-page list).
 *
 * Renders read-only-looking selects backed by `<select>` — gives a
 * polished feel while keeping the markup native and accessible.
 */
export function RuleEditor({ rule, idx, pageId, allPages }: Props) {
  const sourceIndex = allPages.findIndex((p) => p.id === pageId);
  const earlierQs = allPages
    .slice(0, sourceIndex)
    .filter((p) => p.question_id)
    .map((p) => p.question_id as string);
  const targetPage = allPages.find((p) => p.id === rule.goto);
  const broken = !targetPage && rule.goto !== "paywall" && rule.goto !== "end";

  return (
    <div
      className={cn(
        "mt-2.5 rounded-md border bg-rv-c2 p-2.5",
        broken
          ? "border-rv-danger/40 bg-rv-danger/[0.04]"
          : "border-rv-divider",
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-rv-accent-500/20 px-1 font-rv-mono text-[9px] font-bold text-rv-accent-500">
          {idx + 1}
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-rv-mute-500">
          Rule · {rule.combinator === "all" ? "all match" : "any match"}
        </span>
        <button
          type="button"
          title="Delete rule"
          className="ml-auto flex h-5 w-5 cursor-pointer items-center justify-center rounded text-rv-mute-500 transition hover:bg-rv-c3 hover:text-rv-danger"
        >
          <Trash2 size={11} />
        </button>
      </div>

      {rule.clauses.map((c, i) => {
        const isRange = c.op === "between";
        const isArr = c.op === "is_one_of" || c.op === "not_one_of";
        return (
          <Fragment key={i}>
            {i > 0 && (
              <div className="my-1.5 text-center font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-500">
                {rule.combinator}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              <select
                defaultValue={c.qid}
                className="h-6 max-w-[110px] rounded border border-rv-divider bg-rv-c1 px-1.5 font-rv-mono text-[11px] text-rv-accent-500 outline-none focus:border-rv-accent-500"
              >
                {earlierQs.map((q) => (
                  <option key={q} value={q}>
                    {q}
                  </option>
                ))}
              </select>
              <select
                defaultValue={c.op}
                className="h-6 rounded border border-rv-divider bg-rv-c1 px-1.5 text-[11px] text-rv-mute-700 outline-none focus:border-rv-accent-500"
              >
                {OPERATORS.map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.l}
                  </option>
                ))}
              </select>
              {!isRange &&
                !isArr &&
                c.op !== "is_answered" &&
                c.op !== "not_answered" && (
                  <input
                    defaultValue={String(c.value)}
                    className="h-6 max-w-[110px] flex-1 rounded border border-rv-divider bg-rv-c1 px-1.5 font-rv-mono text-[11px] text-foreground outline-none focus:border-rv-accent-500"
                  />
                )}
              {isRange && Array.isArray(c.value) && (
                <>
                  <input
                    defaultValue={String(c.value[0])}
                    className="h-6 w-12 rounded border border-rv-divider bg-rv-c1 px-1.5 font-rv-mono text-[11px] text-foreground outline-none focus:border-rv-accent-500"
                  />
                  <span className="text-[10px] text-rv-mute-500">—</span>
                  <input
                    defaultValue={String(c.value[1])}
                    className="h-6 w-12 rounded border border-rv-divider bg-rv-c1 px-1.5 font-rv-mono text-[11px] text-foreground outline-none focus:border-rv-accent-500"
                  />
                </>
              )}
              {isArr && (
                <input
                  defaultValue={Array.isArray(c.value) ? c.value.join(",") : String(c.value)}
                  className="h-6 max-w-[140px] flex-1 rounded border border-rv-divider bg-rv-c1 px-1.5 font-rv-mono text-[11px] text-foreground outline-none focus:border-rv-accent-500"
                />
              )}
            </div>
          </Fragment>
        );
      })}

      <button
        type="button"
        className="mt-2 inline-flex h-6 cursor-pointer items-center gap-1 rounded px-1.5 text-[11px] text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground"
      >
        <Plus size={10} /> Add clause
      </button>

      <div className="mt-2 flex items-center gap-2 rounded bg-rv-c1 px-2 py-1.5 text-[11px] text-rv-mute-600">
        <span>then</span>
        <ArrowRight size={11} className="text-rv-mute-500" />
        <select
          defaultValue={rule.goto}
          className={cn(
            "h-6 rounded border border-rv-divider bg-rv-c2 px-1.5 font-rv-mono text-[11px] outline-none focus:border-rv-accent-500",
            broken ? "text-rv-danger" : "text-foreground",
          )}
        >
          {allPages.map((p) => (
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
}
