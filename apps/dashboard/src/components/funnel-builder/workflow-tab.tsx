import { ArrowLeftRight, Plus } from "lucide-react";
import type { Funnel } from "./types";
import { RuleEditor } from "./rule-editor";

type Props = {
  funnel: Funnel;
};

/**
 * Workflow tab. Lists every branching rule in the funnel grouped by
 * its source page, in evaluation order. Empty state nudges users
 * toward adding a rule.
 */
export function WorkflowTab({ funnel }: Props) {
  const ruleEntries = Object.entries(funnel.rules);

  return (
    <div className="flex-1 overflow-y-auto bg-rv-bg px-6 py-8">
      <div className="mx-auto max-w-[1100px]">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="m-0 text-[20px] font-semibold tracking-tight">Workflow</h2>
            <p className="mt-1 m-0 text-[13px] text-rv-mute-500">
              All branching rules across this funnel. Rules evaluate top-to-bottom on each source
              page.
            </p>
          </div>
          <button
            type="button"
            className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-rv-accent-500 px-3 text-[13px] font-medium text-white transition hover:bg-rv-accent-600"
          >
            <Plus size={13} />
            Add rule
          </button>
        </div>

        {ruleEntries.length === 0 ? (
          <div className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-14 text-center">
            <div className="mx-auto mb-3.5 flex h-14 w-14 items-center justify-center rounded-xl border border-rv-divider bg-rv-c2 text-rv-accent-500">
              <ArrowLeftRight size={24} />
            </div>
            <h3 className="m-0 mb-1.5 text-[15px] font-semibold">No branching yet</h3>
            <p className="mx-auto m-0 max-w-[320px] text-[12px] text-rv-mute-500">
              Add a rule to send specific visitors down different paths based on their answers.
            </p>
          </div>
        ) : (
          ruleEntries.map(([pageId, rules]) => {
            const page = funnel.pages.find((p) => p.id === pageId);
            return (
              <section
                key={pageId}
                className="mb-3.5 rounded-lg border border-rv-divider bg-rv-c1 px-4 py-4"
              >
                <div className="mb-3 flex items-center gap-2.5">
                  <span className="rounded border border-rv-divider bg-rv-c2 px-1.5 py-0.5 font-rv-mono text-[10px] text-rv-mute-600">
                    {pageId}
                  </span>
                  <span className="text-[13px] text-rv-mute-700">{page?.title}</span>
                  <span className="ml-auto font-rv-mono text-[11px] text-rv-mute-500">
                    {rules.length} rule{rules.length === 1 ? "" : "s"}
                  </span>
                </div>
                {rules.map((r, i) => (
                  <RuleEditor
                    key={r.id}
                    rule={r}
                    idx={i}
                    pageId={pageId}
                    allPages={funnel.pages}
                  />
                ))}
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
