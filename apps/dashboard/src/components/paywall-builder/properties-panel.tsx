import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { cn } from "../../lib/cn";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";
import { NODE_TYPE_LABEL } from "./node-meta";
import { tabIssues, tabsForNode, type InspectorTabId } from "./inspector/tabs";
import { LayoutTab } from "./inspector/layout-tab";
import { StyleTab } from "./inspector/style-tab";
import { ContentTab } from "./inspector/content-tab";
import { BindingTab } from "./inspector/binding-tab";
import { OverridesSection } from "./inspector/overrides";

/** Tab id -> the module that renders it. Keyed by the same ids the table
 * declares, so a tab without a renderer is a compile error. */
const TAB_BODY: Record<InspectorTabId, typeof LayoutTab> = {
  layout: LayoutTab,
  style: StyleTab,
  content: ContentTab,
  binding: BindingTab,
};

export const PropertiesPanel = component(() => {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const node = vm.selectedNode;

  if (!node) {
    return (
      <aside className="flex w-[320px] flex-shrink-0 flex-col items-center justify-center border-l border-rv-divider bg-rv-bg px-6 text-center">
        <div className="rounded-lg border border-dashed border-rv-divider bg-rv-c2 px-4 py-6">
          <div className="text-[13px] font-medium text-foreground">
            {t("paywalls.builder.properties.emptyTitle", "No node selected")}
          </div>
          <div className="mt-1 text-[11px] text-rv-mute-500">
            {t(
              "paywalls.builder.properties.emptyBody",
              "Pick a node from the layer tree or click one in the canvas to edit it here.",
            )}
          </div>
        </div>
      </aside>
    );
  }

  const isRoot = node.id === vm.config.root.id;
  const tabs = tabsForNode(node.type);
  const active = vm.inspectorTab;
  const issues = tabIssues(vm.validationIssues, node.id);
  const Body = active ? TAB_BODY[active] : null;

  return (
    <aside className="flex w-[320px] flex-shrink-0 flex-col overflow-y-auto border-l border-rv-divider bg-rv-c1">
      <div className="flex items-center justify-between border-b border-rv-divider px-4 py-3">
        <div className="min-w-0">
          <h3 className="m-0 text-[13px] font-semibold">
            {t(`paywalls.builder.nodeTypes.${node.type}`, NODE_TYPE_LABEL[node.type])}
          </h3>
          <div className="mt-0.5 truncate font-rv-mono text-[10px] text-rv-mute-500">{node.id}</div>
        </div>
        {!isRoot && (
          <button
            type="button"
            onClick={() => vm.removeNode(node.id)}
            title={t("paywalls.builder.properties.delete", "Delete node")}
            className="flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded text-rv-mute-600 transition hover:bg-rv-danger/10 hover:text-rv-danger"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      <div className="flex items-center gap-0.5 border-b border-rv-divider px-2 py-1.5">
        {tabs.map((tab) => {
          const summary = issues.get(tab.id);
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => vm.setInspectorTab(tab.id)}
              className={cn(
                "relative inline-flex h-7 cursor-pointer items-center rounded px-2.5 text-[12px] transition",
                tab.id === active
                  ? "bg-rv-c3 text-foreground"
                  : "text-rv-mute-600 hover:bg-rv-c2 hover:text-foreground",
              )}
            >
              {t(`paywalls.builder.inspector.tab.${tab.id}`, tab.fallbackLabel)}
              {summary && (
                <span
                  title={t("paywalls.builder.inspector.tabHasIssues", {
                    count: summary.count,
                    defaultValue: "{{count}} validation issue on this tab",
                    defaultValue_other: "{{count}} validation issues on this tab",
                  })}
                  className={cn(
                    "ml-1.5 h-1.5 w-1.5 rounded-full",
                    summary.severity === "error" ? "bg-rv-danger" : "bg-rv-warning",
                  )}
                />
              )}
            </button>
          );
        })}
      </div>

      <div className="flex-1">
        {Body && <Body node={node} />}
        <OverridesSection node={node} />
      </div>
    </aside>
  );
});
