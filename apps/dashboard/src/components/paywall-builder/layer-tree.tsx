import { useRef, useState } from "react";
import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { MAX_BUILDER_DEPTH, type PaywallNode } from "@rovenue/shared/paywall";
import { cn } from "../../lib/cn";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";
import { flattenTree } from "./layer-tree-flatten";
import { isContainerNode, resolveAddTargetId } from "./tree-ops";
import { NODE_ICON, NODE_TYPE_LABEL, nodeLocKey } from "./node-meta";
import { AddNodePopover } from "./add-node-popover";

/**
 * A row at `depth` maps to `measureNodeTree` depth `depth + 1` (that
 * function's depth is 1-based at the root), so a child inserted under a
 * node at `depth` would land at `depth + ADD_CHILD_DEPTH_OFFSET`. Shared by
 * every "add a child here" affordance in this file (a row's own "+", and
 * the panel-wide "New Element" button) so the two can never drift apart.
 */
const ADD_CHILD_DEPTH_OFFSET = 2;

function exceedsAddDepthCap(depth: number): boolean {
  return depth + ADD_CHILD_DEPTH_OFFSET > MAX_BUILDER_DEPTH;
}

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
  // Resolved HERE, in `LayerTree`'s own `component()`-tracked body, rather
  // than inside `NewElementButton` itself: `component()` is the only
  // reactive boundary in this file (impair's `useService` alone — as
  // `LayerRow`/`NewElementButton` use it — doesn't subscribe to anything;
  // it just resolves the service). Reading `vm.selectedNodeId` down inside
  // a plain child component would silently never refresh the button on
  // selection changes, since nothing would ever schedule a re-render for
  // it in isolation. Doing it here makes selecting a node's disabled/title
  // state correct on its own, independent of any ancestor incidentally
  // cascading a re-render for an unrelated reason.
  const addTargetId = resolveAddTargetId(vm.config.root, vm.selectedNodeId);
  const addTargetDepth = rows.find((row) => row.node.id === addTargetId)?.depth ?? 0;
  const addAtDepthCapacity = exceedsAddDepthCap(addTargetDepth);

  return (
    <aside className="flex w-[240px] flex-shrink-0 flex-col border-r border-rv-divider bg-rv-c1">
      <div className="flex items-center justify-between border-b border-rv-divider px-3 py-3">
        <h3 className="m-0 font-rv-mono text-[10px] font-semibold uppercase tracking-wider text-rv-mute-500">
          {t("paywalls.builder.layers.title", "Layers")}
        </h3>
      </div>
      <NewElementButton
        targetId={addTargetId}
        atDepthCapacity={addAtDepthCapacity}
        atNodeCapacity={vm.atNodeCapacity}
      />
      <div className="flex-1 overflow-y-auto py-1">
        {rows.map((row) => (
          <LayerRow
            key={row.node.id}
            node={row.node}
            depth={row.depth}
            parentId={row.parentId}
            index={row.index}
            siblingCount={row.siblingCount}
            isRoot={row.parentId === null}
            isCellTemplateRoot={row.isCellTemplateRoot}
            preview={rowPreview(row.node, localeTable)}
          />
        ))}
      </div>
    </aside>
  );
});

/**
 * Persistent "add" affordance pinned directly under the panel header,
 * above the (scrolling) row list — always visible without hunting for a
 * container row to hover. Unlike a row's own "+", there's no row to
 * anchor from, so the target container/capacity are resolved by the
 * caller (`LayerTree`, the reactive boundary — see the comment there)
 * and handed down as plain props.
 */
function NewElementButton({
  targetId,
  atDepthCapacity,
  atNodeCapacity,
}: {
  targetId: string;
  atDepthCapacity: boolean;
  atNodeCapacity: boolean;
}) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const [addOpen, setAddOpen] = useState(false);
  const [addAnchorRect, setAddAnchorRect] = useState<DOMRect | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);

  const addDisabled = atNodeCapacity || atDepthCapacity;

  function toggleOpen() {
    if (addOpen) {
      setAddOpen(false);
      return;
    }
    setAddAnchorRect(addButtonRef.current?.getBoundingClientRect() ?? null);
    setAddOpen(true);
  }

  return (
    <div className="flex-shrink-0 border-b border-rv-divider p-1.5">
      <button
        ref={addButtonRef}
        type="button"
        disabled={addDisabled}
        title={
          atDepthCapacity
            ? t(
                "paywalls.builder.layers.addAtDepthCapacity",
                "This branch is nested too deeply to add another element.",
              )
            : atNodeCapacity
              ? t(
                  "paywalls.builder.layers.addAtCapacity",
                  "This paywall has reached the maximum number of elements.",
                )
              : t("paywalls.builder.layers.newElement", "New Element")
        }
        onClick={toggleOpen}
        className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded border border-rv-divider-strong py-1.5 text-[12px] font-medium text-foreground transition hover:bg-rv-c2 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Plus size={13} />
        {t("paywalls.builder.layers.newElement", "New Element")}
      </button>
      {addOpen && addAnchorRect && (
        <AddNodePopover
          anchorRect={addAnchorRect}
          onPick={(type) => {
            setAddOpen(false);
            vm.addNode(type, targetId);
          }}
          onClose={() => setAddOpen(false)}
        />
      )}
    </div>
  );
}

function LayerRow({
  node,
  depth,
  parentId,
  index,
  siblingCount,
  isRoot,
  isCellTemplateRoot,
  preview,
}: {
  node: PaywallNode;
  depth: number;
  parentId: string | null;
  index: number;
  siblingCount: number;
  isRoot: boolean;
  isCellTemplateRoot: boolean;
  preview: string | null;
}) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const [addOpen, setAddOpen] = useState(false);
  const [addAnchorRect, setAddAnchorRect] = useState<DOMRect | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const Icon = NODE_ICON[node.type];
  const selected = vm.selectedNodeId === node.id;
  const label = t(`paywalls.builder.nodeTypes.${node.type}`, NODE_TYPE_LABEL[node.type]);
  // A cellTemplate root has no parent+index (see tree-ops' addressability
  // model) — move/reorder controls don't apply to it; "delete" instead
  // clears the whole template off its packageList via setCellTemplate.
  const movable = !isRoot && !isCellTemplateRoot;
  // Node-count and depth are independent caps — `vm.atNodeCapacity` alone
  // would leave the add button enabled right up against the depth cap,
  // opening the popover for a pick that `addNode` then silently refuses.
  const atDepthCapacity = exceedsAddDepthCap(depth);
  const addDisabled = vm.atNodeCapacity || atDepthCapacity;

  function toggleAddOpen() {
    if (addOpen) {
      setAddOpen(false);
      return;
    }
    setAddAnchorRect(addButtonRef.current?.getBoundingClientRect() ?? null);
    setAddOpen(true);
  }

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
        {isCellTemplateRoot && (
          <span className="flex-shrink-0 rounded bg-rv-c3 px-1 py-0.5 font-rv-mono text-[9px] font-semibold uppercase tracking-wider text-rv-mute-600">
            {t("paywalls.builder.layers.cellTemplate", "Cell template")}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
          {label}
          {preview && <span className="ml-1 text-rv-mute-500">{preview}</span>}
        </span>
      </button>

      <div className="flex flex-shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
        {/* Every container type gets the affordance, not just `stack` —
            `isContainerNode` is tree-ops' single switch, so this button is
            offered exactly where `vm.addNode` can actually insert. A
            stickyFooter with no way to hold a purchase button, and a
            carousel with no way to hold a page, were the C2 finding. */}
        {isContainerNode(node) && (
          <>
            <button
              ref={addButtonRef}
              type="button"
              disabled={addDisabled}
              title={
                atDepthCapacity
                  ? t(
                      "paywalls.builder.layers.addAtDepthCapacity",
                      "This branch is nested too deeply to add another element.",
                    )
                  : vm.atNodeCapacity
                    ? t(
                        "paywalls.builder.layers.addAtCapacity",
                        "This paywall has reached the maximum number of elements.",
                      )
                    : t("paywalls.builder.layers.add", "Add node")
              }
              onClick={toggleAddOpen}
              className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-rv-mute-500 transition hover:bg-rv-c3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus size={11} />
            </button>
            {addOpen && addAnchorRect && (
              <AddNodePopover
                anchorRect={addAnchorRect}
                onPick={(type) => {
                  setAddOpen(false);
                  vm.addNode(type, node.id);
                }}
                onClose={() => setAddOpen(false)}
              />
            )}
          </>
        )}
        {movable && (
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
          </>
        )}
        {!isRoot && !isCellTemplateRoot && (
          <button
            type="button"
            title={t("paywalls.builder.layers.delete", "Delete")}
            onClick={() => vm.removeNode(node.id)}
            className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-rv-mute-500 transition hover:bg-rv-danger/15 hover:text-rv-danger"
          >
            <Trash2 size={11} />
          </button>
        )}
        {isCellTemplateRoot && parentId && (
          <button
            type="button"
            title={t("paywalls.builder.layers.cellTemplateRemove", "Remove cell template")}
            onClick={() => vm.setCellTemplate(parentId, "none")}
            className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-rv-mute-500 transition hover:bg-rv-danger/15 hover:text-rv-danger"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
    </div>
  );
}
