import { component, useService } from "impair";
import { ArrowLeftRight } from "lucide-react";
import { pick } from "@rovenue/shared/i18n";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";
import { RuleEditor } from "./rule-editor";

export const WorkflowTab = component(() => {
  const vm = useService(FunnelDraftViewModel);
  const ruleEntries = Object.entries(vm.rules);

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
        </div>

        {ruleEntries.length === 0 ? (
          <div className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-14 text-center">
            <div className="mx-auto mb-3.5 flex h-14 w-14 items-center justify-center rounded-xl border border-rv-divider bg-rv-c2 text-rv-accent-500">
              <ArrowLeftRight size={24} />
            </div>
            <h3 className="m-0 mb-1.5 text-[15px] font-semibold">No branching yet</h3>
            <p className="mx-auto m-0 max-w-[320px] text-[12px] text-rv-mute-500">
              Add a rule on any question page from the Content tab. Rules show up here grouped by
              their source page.
            </p>
          </div>
        ) : (
          ruleEntries.map(([pageId, rules]) => {
            const page = vm.pages.find((p) => p.id === pageId);
            return (
              <section
                key={pageId}
                className="mb-3.5 rounded-lg border border-rv-divider bg-rv-c1 px-4 py-4"
              >
                <div className="mb-3 flex items-center gap-2.5">
                  <span className="rounded border border-rv-divider bg-rv-c2 px-1.5 py-0.5 font-rv-mono text-[10px] text-rv-mute-600">
                    {pageId}
                  </span>
                  <span className="text-[13px] text-rv-mute-700">
                    {page ? pick(page.title, vm.editLocale, [vm.defaultLocale]) : null}
                  </span>
                  <span className="ml-auto font-rv-mono text-[11px] text-rv-mute-500">
                    {rules.length} rule{rules.length === 1 ? "" : "s"}
                  </span>
                </div>
                <RuleEditor pageId={pageId} />
              </section>
            );
          })
        )}
      </div>
    </div>
  );
});
