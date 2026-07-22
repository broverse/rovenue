import { useState } from "react";
import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import type { PaywallNode } from "@rovenue/shared/paywall";
import { cn } from "../../lib/cn";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";
import { flattenTree } from "./layer-tree-flatten";
import { NODE_ICON, NODE_TYPE_LABEL, nodeLocKey } from "./node-meta";
import { AddNodePopover } from "./add-node-popover";

/** Row label: type name, plus a short preview of the node's edit-locale text for text/button/purchaseButton. */
function rowPreview(node: PaywallNode, localeTable: Record<string, string> | undefined): string | null {
  const key = nodeLocKey(node);
  if (key === null) {
    if (node.type === "stack") return `${node.axis.toUpperCase()} · ${node.children.length}`;
    if (node.type === "packageList") return `${node.packageIds.length || "all"} packages`;
    if (node.type === "spacer") return `${node.size ?? 16}px`;
    return null;
  }
  const value = localeTable?.[key];
  return value ? `“${value}”` : `{${key}}`;
}

export const LayerTree = component(() => {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const rows = flattenTree(vm.config.root);
  const localeTable = vm.config.localizations[vm.editLocale];

  return (
    <aside className="flex w-[240px] flex-shrink-0 flex-col overflow-y-auto border-r border-rv-divider bg-rv-c1">
      <div className="flex items-center justify-between border-b border-rv-divider px-3 py-3">
        <h3 className="m-0 font-rv-mono text-[10px] font-semibold uppercase tracking-wider text-rv-mute-500">
          {t("paywalls.builder.layers.title", "Layers")}
        </h3>
      </div>
      <div className="flex-1 py-1">
        {rows.map((row) => (
          <LayerRow
            key={row.node.id}
            node={row.node}
            depth={row.depth}
            index={row.index}
            siblingCount={row.siblingCount}
            isRoot={row.parentId === null}
            preview={rowPreview(row.node, localeTable)}
          />
        ))}
      </div>
    </aside>
  );
});

function LayerRow({
  node,
  depth,
  index,
  siblingCount,
  isRoot,
  preview,
}: {
  node: PaywallNode;
  depth: number;
  index: number;
  siblingCount: number;
  isRoot: boolean;
  preview: string | null;
}) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const [addOpen, setAddOpen] = useState(false);
  const Icon = NODE_ICON[node.type];
  const selected = vm.selectedNodeId === node.id;
  const label = t(`paywalls.builder.nodeTypes.${node.type}`, NODE_TYPE_LABEL[node.type]);

  return (
    <div
      className={cn(
        "group relative flex items-center gap-1.5 border-l-2 py-1 pr-1.5 transition",
        selected ? "border-rv-accent-500 bg-rv-accent-500/10" : "border-transparent hover:bg-rv-c2",
      )}
      style={{ paddingLeft: 10 + depth * 14 }}
    >
      <button
        type="button"
        onClick={() => vm.selectNode(node.id)}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
      >
        <Icon size={13} className="flex-shrink-0 text-rv-mute-500" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
          {label}
          {preview && <span className="ml-1 text-rv-mute-500">{preview}</span>}
        </span>
      </button>

      <div className="flex flex-shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
        {node.type === "stack" && (
          <div className="relative">
            <button
              type="button"
              title={t("paywalls.builder.layers.add", "Add node")}
              onClick={() => setAddOpen((o) => !o)}
              className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-rv-mute-500 transition hover:bg-rv-c3 hover:text-foreground"
            >
              <Plus size={11} />
            </button>
            {addOpen && (
              <AddNodePopover
                onPick={(type) => {
                  setAddOpen(false);
                  vm.addNode(type, node.id);
                }}
                onClose={() => setAddOpen(false)}
              />
            )}
          </div>
        )}
        {!isRoot && (
          <>
            <button
              type="button"
              title={t("paywalls.builder.layers.moveUp", "Move up")}
              disabled={index === 0}
              onClick={() => vm.moveNode(node.id, -1)}
              className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-rv-mute-500 transition hover:bg-rv-c3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ChevronUp size={11} />
            </button>
            <button
              type="button"
              title={t("paywalls.builder.layers.moveDown", "Move down")}
              disabled={index === siblingCount - 1}
              onClick={() => vm.moveNode(node.id, 1)}
              className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-rv-mute-500 transition hover:bg-rv-c3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ChevronDown size={11} />
            </button>
            <button
              type="button"
              title={t("paywalls.builder.layers.delete", "Delete")}
              onClick={() => vm.removeNode(node.id)}
              className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-rv-mute-500 transition hover:bg-rv-danger/15 hover:text-rv-danger"
            >
              <Trash2 size={11} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
