import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { component, useService } from "impair";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Maximize, Minus, Plus } from "lucide-react";
import { PaywallRenderer } from "@rovenue/paywall-renderer";
import type { DashboardOfferingRow } from "@rovenue/shared";
import type { StackNode } from "@rovenue/shared/paywall";
import { cn } from "../../lib/cn";
import { rpc, unwrap } from "../../lib/api";
import { useOfferingById } from "../../lib/hooks/useProjectOfferings";
import { useOfferingResolvedPrices } from "../../lib/hooks/useOfferingResolvedPrices";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";
import {
  buildEligibilityMap,
  computeResizedSize,
  computeSelectionRect,
  isResizableNode,
  resolvedPriceView,
  toRendererOffering,
  type CanvasPriceCoverage,
  type Rect,
  type ResizeCorner,
} from "./canvas-helpers";
import { canMoveTo, findNode, findParent } from "./tree-ops";
import {
  CANVAS_DRAG_THRESHOLD_PX,
  CANVAS_INSERTION_LINE_THICKNESS_PX,
  resolveCanvasDropTarget,
  type CanvasDragCandidate,
  type CanvasDropResolution,
  type CanvasNodeInfo,
} from "./canvas-drag";
import { deviceById, devicesForPlatform } from "./device-catalog";
import { DeviceFrame } from "./device-frame";

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];
// All-sizes mode ignores the live zoom and renders every device at a fixed
// scale so the whole platform fits in a scrolling row.
const ALL_SIZES_SCALE = 0.64;

/** Frame id stamped on the single-device wrapper's `data-rov-frame` — any
 * stable string works, since drag scoping compares DOM node identity, not
 * this value (see `handleCanvasPointerDown`'s comment). */
const SINGLE_FRAME_ID = "single";

// =============================================================
// Selection chrome — a crisp 1px outline drawn exactly on the selected
// node's bounding box (no ring glow/offset), plus corner resize handles
// for the one node type whose schema carries a `size` box (`isResizableNode`
// — see canvas-helpers.ts). Handle geometry constants live here since
// they're pure presentation (px sizes, cursors, shadow), not shared with
// any other surface the way the drag constants in canvas-drag.ts are.
// =============================================================

/** Edge length of a corner resize handle square, in CSS px — matches
 * Tailwind's `size-2` (0.5rem = 8px) used on the handle element itself. */
const RESIZE_HANDLE_SIZE_PX = 8;
/** Half the handle size, used to center each handle square ON the corner
 * (rather than inside or outside the selection box). */
const RESIZE_HANDLE_HALF_PX = RESIZE_HANDLE_SIZE_PX / 2;
/** Subtle drop shadow under each handle, matching the design spec exactly
 * (a design-tool handle needs just enough depth to read as "liftable"). */
const RESIZE_HANDLE_SHADOW = "0 1px 2px rgba(0,0,0,0.25)";
/** Gap between the selection box's bottom edge and the live dimension
 * badge shown while resizing. */
const RESIZE_BADGE_GAP_PX = 6;

/** One entry per corner: which CSS cursor to show, and which two edges
 * (`insetX`/`insetY`) the handle centers itself against — e.g. the "tl"
 * handle sits at `left`/`top`, "br" at `right`/`bottom`, so it stays
 * pinned to ITS corner as the selection box's width/height change. */
const RESIZE_HANDLES: ReadonlyArray<{
  corner: ResizeCorner;
  cursor: string;
  insetX: "left" | "right";
  insetY: "top" | "bottom";
}> = [
  { corner: "tl", cursor: "cursor-nwse-resize", insetX: "left", insetY: "top" },
  { corner: "tr", cursor: "cursor-nesw-resize", insetX: "right", insetY: "top" },
  { corner: "bl", cursor: "cursor-nesw-resize", insetX: "left", insetY: "bottom" },
  { corner: "br", cursor: "cursor-nwse-resize", insetX: "right", insetY: "bottom" },
];

/** Live bookkeeping for one in-progress corner resize, kept in a ref for
 * the same reason `CanvasDragState` is: `endCanvasResize` must always read
 * the LATEST values, not ones captured by a stale closure. */
type CanvasResizeState = {
  id: string;
  corner: ResizeCorner;
  /** Mirrors `CanvasDragState.pointerId` — the pointer that armed this
   * resize; every subsequent move/up/cancel is filtered against it. */
  pointerId: number;
  /** The selection box in canvas-chrome coordinates, captured once at
   * resize start — `computeResizedSize`'s anchor-corner math is relative
   * to THIS rect for the whole gesture, never re-measured mid-drag. */
  startRect: Rect;
  /** Zoom captured at start alongside `startRect`, so a (hypothetical)
   * zoom change mid-drag can't retroactively skew an in-progress resize. */
  zoom: number;
  /** The node's `size` before this resize started — restored verbatim on
   * Escape/cancel. */
  previousSize: StackNode["size"];
};

// =============================================================
// Part 2 of paywall-builder drag-and-drop: dragging elements directly
// inside the device mockup. Pointer-event-based (pointerdown/pointermove/
// pointerup on the canvas viewport), NOT HTML5 DnD — `packages/paywall-renderer`
// renders live production paywalls and must never grow a `draggable`
// attribute or any other builder-only DOM. Every rendered node already
// carries `data-rov-node="<id>"` (used by `handleClick`'s selection and
// the selection-ring effect below); dragging hit-tests that same
// attribute via `document.elementsFromPoint` rather than adding anything
// new to the renderer's own markup.
//
// All the zone/legality math is pure and lives in `canvas-drag.ts`
// (`computeCanvasDropZone`/`resolveCanvasDropTarget`); this file only:
// resolves DOM candidates + the config-tree lookup they need, maps
// viewport rects into the scroll container's local space for the overlay
// (`toLocalRect`, reusing the same `computeSelectionRect` helper the
// selection ring uses), and calls `vm.moveNodeTo` on drop.
// =============================================================

/** Live bookkeeping for one in-progress canvas drag, kept in a ref (not
 * state) so `endCanvasDrag` always reads the LATEST resolved drop target
 * rather than a value captured by a stale closure — see the ref's own
 * declaration comment. */
type CanvasDragState = {
  id: string;
  /** The pointer that armed this drag (`PointerEvent.pointerId`). One drag
   * at a time: a second pointerdown while this is set is ignored outright
   * (see `handleCanvasPointerDown`), and every subsequent pointermove/
   * pointerup/pointercancel checks its OWN `pointerId` against this one so
   * a stray second pointer (multi-touch, stylus + touch) can't move or end
   * a drag it didn't start. */
  pointerId: number;
  /** The exact DOM element the drag started on — kept directly (rather
   * than re-querying by id later) so the source ghost never risks the
   * same by-id ambiguity All-sizes creates for every OTHER lookup. */
  sourceEl: HTMLElement;
  /** The `[data-rov-frame]` ancestor the drag started in — hit-testing
   * during the drag is scoped to this exact DOM node (see
   * `handleCanvasPointerMove`). */
  frameEl: HTMLElement;
  startX: number;
  startY: number;
  /** False until the pointer has moved past `CANVAS_DRAG_THRESHOLD_PX` —
   * before that, this is still a candidate plain click. */
  active: boolean;
  /** The last legal drop this drag resolved to, or null if none yet /
   * the pointer isn't currently over a legal target. */
  resolution: CanvasDropResolution | null;
};

interface ProductNameDto {
  id: string;
  displayName: string;
}

/** Resolves offering package -> product displayName for the canvas preview only. */
function useProductDisplayNames(projectId: string) {
  return useQuery({
    queryKey: ["paywall-builder-product-names", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      unwrap<{ products: ProductNameDto[]; nextCursor: string | null }>(
        rpc.dashboard.projects[":projectId"].products.$get({
          param: { projectId },
          query: {},
        }),
      ),
    select: (r) => new Map(r.products.map((p) => [p.id, p.displayName])),
  });
}

function noop() {
  // Preview canvas: purchase/close/restore/url are inert — this is a design surface, not a live paywall.
}

/**
 * Inline style for the "before"/"after" insertion line: a thin bar spanning
 * the target's full width (vertical split, drawn at its top/bottom edge) or
 * full height (horizontal split, drawn at its left/right edge). `rect` is
 * already in the canvas viewport's local coordinate space (`toLocalRect`),
 * so this is a pure layout computation with no DOM access of its own.
 */
function insertionLineStyle(preview: { resolution: CanvasDropResolution; rect: Rect }): React.CSSProperties {
  const { resolution, rect } = preview;
  const isAfter = resolution.zone === "after";
  const half = CANVAS_INSERTION_LINE_THICKNESS_PX / 2;
  if (resolution.splitAxis === "horizontal") {
    return {
      top: rect.top,
      height: rect.height,
      width: CANVAS_INSERTION_LINE_THICKNESS_PX,
      left: (isAfter ? rect.left + rect.width : rect.left) - half,
    };
  }
  return {
    left: rect.left,
    width: rect.width,
    height: CANVAS_INSERTION_LINE_THICKNESS_PX,
    top: (isAfter ? rect.top + rect.height : rect.top) - half,
  };
}

/** Badge copy tracks how much of the preview is real: all packages resolved, some, or none. */
function previewBadgeText(t: (key: string, fallback: string) => string, coverage: CanvasPriceCoverage): string {
  if (coverage === "full") {
    return t("paywalls.builder.canvas.previewBadgeLive", "Preview — live store prices (US)");
  }
  if (coverage === "partial") {
    return t("paywalls.builder.canvas.previewBadgeMixed", "Preview — mixed live and placeholder prices");
  }
  return t("paywalls.builder.canvas.previewBadge", "Preview — placeholder prices");
}

export const Canvas = component(() => {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);

  const offeringQuery = useOfferingById(vm.projectId, vm.paywall?.offeringId ?? null);
  const { data: displayNameById = new Map<string, string>() } = useProductDisplayNames(vm.projectId);

  const offering = useMemo(
    () => toRendererOffering(offeringQuery.data?.offering as DashboardOfferingRow | undefined, displayNameById),
    [offeringQuery.data, displayNameById],
  );
  const resolvedQuery = useOfferingResolvedPrices(vm.projectId, vm.paywall?.offeringId ?? null);
  const { view: priceView, coverage: priceCoverage } = useMemo(
    () => resolvedPriceView(offering, resolvedQuery.data, vm.canvasPlatform),
    [offering, resolvedQuery.data, vm.canvasPlatform],
  );
  const eligibility = useMemo(
    () => buildEligibilityMap(offering, vm.previewEligible),
    [offering, vm.previewEligible],
  );

  // The renderer's package selection is one-shot (useState initializer) —
  // remount it whenever `config`'s identity changes so structural edits
  // (e.g. picking a different defaultSelected, adding/removing packages)
  // are always reflected instead of showing a stale selection.
  const prevConfigRef = useRef(vm.config);
  const revisionRef = useRef(0);
  if (prevConfigRef.current !== vm.config) {
    prevConfigRef.current = vm.config;
    revisionRef.current += 1;
  }
  const rendererKey = `${revisionRef.current}`;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const wheelCleanupRef = useRef<(() => void) | null>(null);
  const setViewportEl = useCallback(
    (el: HTMLDivElement | null) => {
      wheelCleanupRef.current?.();
      wheelCleanupRef.current = null;
      viewportRef.current = el;
      if (!el) return;
      const onWheel = (e: WheelEvent) => {
        // All-sizes renders at a fixed scale, so zoom is meaningless there —
        // let the wheel scroll the grid natively instead of hijacking it
        // (preventDefault here would make the row unscrollable).
        if (vm.showAllSizes) return;
        e.preventDefault();
        e.stopPropagation();
        vm.handleCanvasWheel(e.deltaY, e.ctrlKey);
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      wheelCleanupRef.current = () => el.removeEventListener("wheel", onWheel);
    },
    [vm],
  );

  const [ring, setRing] = useState<Rect | null>(null);
  // Bumped by viewport scroll / window resize so the ring re-anchors —
  // without this it drifts off the selected node until a zoom/device/
  // selection change forces a recompute (whole-phase review follow-up).
  const [ringTick, setRingTick] = useState(0);

  useLayoutEffect(() => {
    const container = viewportRef.current;
    const bump = () => setRingTick((t) => t + 1);
    container?.addEventListener("scroll", bump, { passive: true });
    window.addEventListener("resize", bump);
    return () => {
      container?.removeEventListener("scroll", bump);
      window.removeEventListener("resize", bump);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendererKey]);

  useLayoutEffect(() => {
    const container = viewportRef.current;
    const id = vm.selectedNodeId;
    // All-sizes mounts one renderer per frame, so every `data-rov-node` id
    // exists N times and `querySelector` would anchor the ring to the FIRST
    // frame regardless of which one was clicked. Suppress it rather than
    // point at the wrong device.
    if (!container || !id || vm.showAllSizes) {
      setRing(null);
      return;
    }
    const target = container.querySelector<HTMLElement>(`[data-rov-node="${CSS.escape(id)}"]`);
    if (!target) {
      setRing(null);
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    setRing(
      computeSelectionRect(
        { left: containerRect.left, top: containerRect.top },
        { left: container.scrollLeft, top: container.scrollTop },
        {
          left: targetRect.left,
          top: targetRect.top,
          width: targetRect.width,
          height: targetRect.height,
        },
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // `showAllSizes` belongs here too: toggling it swaps a single centred
    // frame for an N-frame row at a different scale, so every node moves.
  }, [vm.selectedNodeId, rendererKey, vm.canvasZoom, vm.canvasDevice, vm.showAllSizes, ringTick]);

  // A drag that crossed `CANVAS_DRAG_THRESHOLD_PX` must not ALSO select via
  // the trailing click the browser fires on pointerup — `handleClick`
  // checks this ref first and clears it. Left `false` for a plain click
  // (below threshold), so that regression case needs no special-casing.
  const suppressClickRef = useRef(false);
  const dragRef = useRef<CanvasDragState | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  // Mirror the ref's live/visual bits into state purely so the overlay
  // (rendered below) re-renders as the drag progresses; `dragRef` stays
  // the single source of truth read at commit time, so a stale closure
  // over these state values can never cause a wrong or duplicate move.
  const [isCanvasDragging, setIsCanvasDragging] = useState(false);
  const [dragSourceRect, setDragSourceRect] = useState<Rect | null>(null);
  const [dropPreview, setDropPreview] = useState<{ resolution: CanvasDropResolution; rect: Rect } | null>(null);

  // Corner resize — same single-source-of-truth-ref pattern as the move
  // drag above; declared alongside it so `handleCanvasPointerDown`'s
  // "one operation at a time" gate (below) can reference `resizeRef`
  // and vice versa.
  const resizeRef = useRef<CanvasResizeState | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  // The live `{width, height}` node-px badge shown while resizing; also
  // doubles as the "a resize is in progress" flag (non-null exactly
  // while one is), so there's no separate boolean to keep in sync.
  const [resizeDims, setResizeDims] = useState<{ width: number; height: number } | null>(null);

  /** Maps a viewport-space rect (`getBoundingClientRect()`) into the scroll
   * container's local coordinate space — the exact transform the selection
   * ring above uses, so the drag overlay gets the same zoom/scroll handling
   * for free (rects are already CSS-scaled, so no separate zoom math). */
  const toLocalRect = useCallback((rect: Rect): Rect => {
    const container = viewportRef.current;
    if (!container) return rect;
    const containerRect = container.getBoundingClientRect();
    return computeSelectionRect(
      { left: containerRect.left, top: containerRect.top },
      { left: container.scrollLeft, top: container.scrollTop },
      rect,
    );
  }, []);

  /** Resolves a `data-rov-node` id to what `resolveCanvasDropTarget` needs,
   * via the SAME `findNode`/`findParent` tree-ops.ts exports Part 1 (the
   * Layers panel) uses — no new legality/addressability logic here. */
  const lookupNodeInfo = useCallback(
    (id: string): CanvasNodeInfo | null => {
      const node = findNode(vm.config.root, id);
      if (!node) return null;
      const located = findParent(vm.config.root, id);
      return { node, parentId: located ? located.parent.id : null, index: located ? located.index : 0 };
    },
    [vm],
  );

  /** Tears down the drag: removes the document-level listeners, and — when
   * `commit` is true and the pointer moved past the threshold — applies
   * whatever drop `dragRef` last resolved (a no-op if it never resolved
   * one, e.g. the pointer never hovered a legal target). Escape and
   * pointercancel call this with `commit: false`, discarding any pending
   * resolution instead of applying it. */
  const endCanvasDrag = useCallback(
    (commit: boolean) => {
      const drag = dragRef.current;
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
      dragRef.current = null;
      if (drag?.active) {
        suppressClickRef.current = true; // swallow the trailing click either way
        if (commit && drag.resolution) {
          vm.moveNodeTo(drag.id, drag.resolution.parentId, drag.resolution.index);
          // Keep the dragged node selected after a successful move — the
          // suppressed click never re-selects it.
          vm.selectNode(drag.id);
        }
      }
      setDropPreview(null);
      setDragSourceRect(null);
      setIsCanvasDragging(false);
    },
    [vm],
  );

  function handleCanvasPointerMove(ev: PointerEvent) {
    const drag = dragRef.current;
    if (!drag || ev.pointerId !== drag.pointerId) return; // a different, stray pointer — ignore
    const clientX = ev.clientX;
    const clientY = ev.clientY;

    if (!drag.active) {
      const dx = clientX - drag.startX;
      const dy = clientY - drag.startY;
      if (Math.hypot(dx, dy) < CANVAS_DRAG_THRESHOLD_PX) return; // still a plain click, maybe
      drag.active = true;
      setIsCanvasDragging(true);
      setDragSourceRect(toLocalRect(drag.sourceEl.getBoundingClientRect()));
    }

    // Deepest-first, exactly like the DOM already stacks them.
    const elements = document.elementsFromPoint(clientX, clientY);
    const candidates: CanvasDragCandidate[] = [];
    const seen = new Set<string>();
    for (const el of elements) {
      if (!(el instanceof HTMLElement)) continue;
      const nodeEl = el.closest<HTMLElement>("[data-rov-node]");
      if (!nodeEl) continue;
      // Scope to the frame the drag STARTED in: All-sizes mounts the whole
      // tree once per device, so every id repeats across frames. Comparing
      // DOM node identity (not a frame id string) is the simplest rule that
      // still can't confuse two frames — a drag never resolves a target in
      // a frame other than the one it began in, it just shows no indicator
      // while the pointer is over a different frame.
      if (nodeEl.closest("[data-rov-frame]") !== drag.frameEl) continue;
      const nodeId = nodeEl.getAttribute("data-rov-node");
      if (!nodeId || seen.has(nodeId)) continue;
      seen.add(nodeId);
      candidates.push({ nodeId, rect: nodeEl.getBoundingClientRect() });
    }

    const resolution = resolveCanvasDropTarget(
      candidates,
      { x: clientX, y: clientY },
      drag.id,
      lookupNodeInfo,
      (parentId) => canMoveTo(vm.config.root, drag.id, parentId),
    );
    drag.resolution = resolution;

    if (!resolution) {
      setDropPreview(null);
      return;
    }
    const targetRect = candidates.find((c) => c.nodeId === resolution.targetNodeId)?.rect;
    setDropPreview(targetRect ? { resolution, rect: toLocalRect(targetRect) } : null);
  }

  const handleCanvasPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return; // primary press only
      // One drag at a time: a second pointerdown arriving before the first
      // one's pointerup/pointercancel/Escape (multi-touch, stylus + touch)
      // must NOT overwrite `dragRef`/`dragCleanupRef` — that would orphan
      // the first drag's four document listeners forever (nothing else
      // retains that closure, and unmount only ever cleans up the CURRENT
      // one). Simplest correct rule: ignore it outright. Also bail while a
      // corner resize is in flight — the two operations are mutually
      // exclusive (see `handleResizePointerDown`'s matching check).
      if (dragRef.current || resizeRef.current) return;
      const nodeEl = (e.target as HTMLElement).closest<HTMLElement>("[data-rov-node]");
      if (!nodeEl) return;
      const id = nodeEl.getAttribute("data-rov-node");
      // `findParent` returning null covers BOTH the root and a cellTemplate
      // root (tree-ops.ts's addressability model) — the same gate
      // `moveNodeTo` itself applies, so no new legality logic lives here.
      // The explicit root-id check is redundant with it but kept since a
      // pointerdown on empty device-screen space is the single most common
      // way to land on the root.
      if (!id || id === vm.config.root.id || !findParent(vm.config.root, id)) return;
      const frameEl = nodeEl.closest<HTMLElement>("[data-rov-frame]");
      if (!frameEl) return; // defensive — every rendered frame carries this

      dragRef.current = {
        id,
        pointerId: e.pointerId,
        sourceEl: nodeEl,
        frameEl,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
        resolution: null,
      };

      const onMove = (ev: PointerEvent) => handleCanvasPointerMove(ev);
      // A stray second pointer's up/cancel must not tear down the FIRST
      // pointer's still-in-progress drag — same `pointerId` check
      // `handleCanvasPointerMove` applies.
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId === dragRef.current?.pointerId) endCanvasDrag(true);
      };
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId === dragRef.current?.pointerId) endCanvasDrag(false);
      };
      const onKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") endCanvasDrag(false);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onCancel);
      document.addEventListener("keydown", onKeyDown);
      dragCleanupRef.current = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onCancel);
        document.removeEventListener("keydown", onKeyDown);
      };
    },
    [vm, endCanvasDrag],
  );

  // Belt-and-suspenders: if the Canvas unmounts mid-drag (e.g. navigating
  // away), don't leak the document-level listeners.
  useEffect(() => () => dragCleanupRef.current?.(), []);

  // =============================================================
  // Corner resize handles. Structurally mirrors the move-drag above:
  // `resizeRef` is the single source of truth (read at commit time, never
  // a stale closure), `pointerId` is captured at start and filtered on
  // every move/up/cancel, Escape restores the pre-resize `size`, and every
  // document listener is cleaned up on every exit path including unmount.
  // Unlike the move-drag, there is no "below-threshold = plain click"
  // phase — a handle's whole purpose is dragging, so the resize is armed
  // immediately on pointerdown, and the box tracks the pointer from the
  // very first move.
  // =============================================================

  /** Tears down the resize: removes the document-level listeners, and — on
   * Escape/cancel (`commit: false`) — restores the node's pre-resize
   * `size` (every live pointermove already applied a size, so there is
   * always something concrete to undo). A committed resize needs no extra
   * write here: the last pointermove already applied the final size. */
  const endCanvasResize = useCallback(
    (commit: boolean) => {
      const resize = resizeRef.current;
      resizeCleanupRef.current?.();
      resizeCleanupRef.current = null;
      resizeRef.current = null;
      if (resize && !commit) {
        vm.updateNode<StackNode>(resize.id, { size: resize.previousSize });
      }
      setResizeDims(null);
      // Belt-and-suspenders: force the selection ring to re-measure once
      // the gesture is fully over, in case the DOM lagged a frame behind
      // the last live update (see `handleResizePointerMove`'s comment on
      // why it's normally unnecessary).
      setRingTick((t) => t + 1);
    },
    [vm],
  );

  function handleResizePointerMove(ev: PointerEvent) {
    const resize = resizeRef.current;
    if (!resize || ev.pointerId !== resize.pointerId) return; // a different, stray pointer — ignore
    // The overlay/ring lives in canvas-chrome coordinates; convert the raw
    // client-space pointer into that same space (a zero-size "rect" at the
    // pointer position) before handing it to the pure resize math.
    const pointer = toLocalRect({ left: ev.clientX, top: ev.clientY, width: 0, height: 0 });
    const { width, height } = computeResizedSize(
      resize.corner,
      { x: pointer.left, y: pointer.top },
      resize.startRect,
      resize.zoom,
    );
    setResizeDims({ width, height });
    // Applied LIVE (not just on release) — this is what makes the box
    // itself track the drag, not merely the overlay. `vm.updateNode`
    // changes `vm.config`'s identity, which bumps `rendererKey` above,
    // which is already a dependency of the selection-ring recompute effect
    // — so that same machinery re-measures and re-anchors the ring/handles
    // on every one of these live updates with no separate resize-specific
    // recompute path needed.
    vm.updateNode<StackNode>(resize.id, { size: { width, height } });
  }

  const handleResizePointerDown = useCallback(
    (corner: ResizeCorner) => (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return; // primary press only
      // Mutual exclusion with the move-drag, and with a second resize
      // starting before the first ends (multi-touch) — same "ignore it
      // outright" rule `handleCanvasPointerDown` applies to itself.
      if (dragRef.current || resizeRef.current) return;
      const id = vm.selectedNodeId;
      if (!id || !ring) return; // defensive — a handle only renders when both exist
      const node = findNode(vm.config.root, id);
      if (!node || !isResizableNode(node)) return; // defensive — handles only render for these anyway
      // Handles are overlay chrome, not `[data-rov-node]`, so the
      // viewport's move-drag pointerdown handler already ignores this
      // event on its own (its `.closest("[data-rov-node]")` lookup finds
      // nothing) — this stop is belt-and-suspenders, and also keeps the
      // resize from ever reaching `handleClick`'s trailing click.
      e.stopPropagation();

      resizeRef.current = {
        id,
        corner,
        pointerId: e.pointerId,
        startRect: ring,
        zoom: vm.canvasZoom,
        previousSize: node.size,
      };
      // Seed the badge with the box's CURRENT node-px size (no pointer
      // movement yet to derive one from).
      setResizeDims({
        width: Math.round(ring.width / vm.canvasZoom),
        height: Math.round(ring.height / vm.canvasZoom),
      });

      const onMove = (ev: PointerEvent) => handleResizePointerMove(ev);
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId === resizeRef.current?.pointerId) endCanvasResize(true);
      };
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId === resizeRef.current?.pointerId) endCanvasResize(false);
      };
      const onKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") endCanvasResize(false);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onCancel);
      document.addEventListener("keydown", onKeyDown);
      resizeCleanupRef.current = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onCancel);
        document.removeEventListener("keydown", onKeyDown);
      };
    },
    [vm, ring, endCanvasResize],
  );

  // Belt-and-suspenders: if the Canvas unmounts mid-resize, don't leak the
  // document-level listeners (mirrors the drag cleanup above).
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      const el = (e.target as HTMLElement).closest("[data-rov-node]");
      if (!el) return;
      const id = el.getAttribute("data-rov-node");
      if (id) vm.selectNode(id);
    },
    [vm],
  );

  // Gates the corner resize handles: only the selected node types whose
  // schema carries a `size` box get them (see `isResizableNode`) — every
  // other selection gets the selection outline alone.
  const selectedNodeResizable = useMemo(() => {
    if (!vm.selectedNodeId) return false;
    const node = findNode(vm.config.root, vm.selectedNodeId);
    return node !== null && isResizableNode(node);
  }, [vm.selectedNodeId, vm.config]);

  const zoom = vm.canvasZoom;
  const spec = deviceById(vm.canvasDevice);
  // The paywall's own background is painted edge-to-edge behind the frame
  // chrome, matching the SDK (which lets the background ignore safe areas
  // and only insets content). Undefined → the frame's scheme default.
  const screenBackground = vm.config.background
    ? vm.colorScheme === "dark"
      ? (vm.config.background.dark ?? vm.config.background.light)
      : vm.config.background.light
    : undefined;

  // Factored so the single-device and all-sizes branches share one renderer
  // function; each DeviceFrame is a distinct parent, so React mounts an
  // independent renderer instance per frame. Takes `frameId` so each call
  // site can stamp a DISTINCT `data-rov-frame` marker — the drag scoping
  // boundary in `handleCanvasPointerMove`/`handleCanvasPointerDown` (All-
  // sizes renders this same function once per device, so ids repeat).
  const renderPaywall = (frameId: string) => (
    // `h-full`, not `min-h-full`: the renderer root is `height: 100%`, and a
    // percentage height resolves to `auto` against an auto-height ancestor.
    // With `min-h-full` (min-height:100%, height:auto) the whole scroll model
    // went inert in the canvas — no viewport fill, no scroller, and a
    // "pinned" footer floating under the content mid-frame instead of at the
    // bottom of the device. The DeviceFrame's content area is absolutely
    // positioned with top+bottom, so it IS a definite height to resolve
    // against; this wrapper is the one link that broke the chain.
    <div data-rov-frame={frameId} onClick={handleClick} className="h-full">
      <PaywallRenderer
        key={rendererKey}
        // No `firstShownAt` on purpose. This is an AUTHORING preview: a
        // persisted "first shown" anchor (what the funnel runner passes, and
        // what the SDKs read from UserDefaults/SharedPreferences) would be
        // stamped the first time an author opened the paywall and never
        // move, so every later editing session would show a `durationSeconds`
        // countdown already expired — frozen at 00:00, or invisible under
        // `onExpiry: "hide"`. Anchoring to mount instead means the author
        // sees the countdown their buyer sees on FIRST open, which is the
        // frame worth previewing.
        config={vm.config}
        offering={offering}
        locale={vm.editLocale}
        colorScheme={vm.colorScheme}
        priceView={priceView}
        eligibility={eligibility}
        // The previewed device's platform, so node visibility rules show
        // their effect as the author switches between an iPhone and a
        // Pixel. No appVersion on purpose: there is no app behind the
        // builder, and the fail-open rule then previews version bounds as
        // visible — honest, since the builder cannot know what is in the
        // field.
        platform={vm.canvasPlatform}
        onPurchase={noop}
        onClose={noop}
        onRestore={noop}
        onUrl={noop}
      />
    </div>
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-rv-bg">
      <div className="flex items-center gap-2 border-b border-rv-divider bg-rv-c1 px-4 py-2">
        <div className="inline-flex items-center gap-0.5 rounded-md border border-rv-divider bg-rv-c2 px-0.5">
          <button
            type="button"
            onClick={() => vm.zoomStep(-1)}
            title={t("paywalls.builder.canvas.zoomOut", "Zoom out")}
            disabled={vm.showAllSizes || zoom === ZOOM_STEPS[0]}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Minus size={12} />
          </button>
          <button
            type="button"
            onClick={() => vm.resetCanvasZoom()}
            title={t("paywalls.builder.canvas.zoomReset", "Reset zoom (1×)")}
            className="min-w-[44px] cursor-pointer rounded px-1 font-rv-mono text-[11px] tabular-nums text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={() => vm.zoomStep(1)}
            title={t("paywalls.builder.canvas.zoomIn", "Zoom in")}
            disabled={vm.showAllSizes || zoom === ZOOM_STEPS[ZOOM_STEPS.length - 1]}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus size={12} />
          </button>
        </div>
        <button
          type="button"
          title={t("paywalls.builder.canvas.fit", "Fit to canvas (1×)")}
          onClick={() => vm.resetCanvasZoom()}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-rv-mute-600 transition hover:bg-rv-c2 hover:text-foreground"
        >
          <Maximize size={13} />
        </button>

        <div className="mx-1 h-5 w-px bg-rv-divider" />

        {/* platform segment */}
        <div className="inline-flex rounded-md border border-rv-divider bg-rv-c2 p-0.5">
          {(["ios", "android"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => vm.setCanvasPlatform(p)}
              className={cn(
                "cursor-pointer rounded px-2 py-1 text-[11px] font-medium capitalize transition",
                vm.canvasPlatform === p ? "bg-rv-c4 text-foreground" : "text-rv-mute-600 hover:text-foreground",
              )}
            >
              {p === "ios"
                ? t("paywalls.builder.canvas.platformIos", "iOS")
                : t("paywalls.builder.canvas.platformAndroid", "Android")}
            </button>
          ))}
        </div>

        {/* device dropdown */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setDeviceMenuOpen((o) => !o)}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2 text-[11px] text-foreground transition hover:bg-rv-c3"
          >
            {deviceById(vm.canvasDevice).label}
            <span className="font-rv-mono text-[10px] text-rv-mute-500">
              {deviceById(vm.canvasDevice).w}×{deviceById(vm.canvasDevice).h}
            </span>
          </button>
          {deviceMenuOpen && (
            <>
              <div className="fixed inset-0 z-[49]" onClick={() => setDeviceMenuOpen(false)} />
              <div className="absolute left-0 top-full z-50 mt-1 w-[220px] rounded-lg border border-rv-divider-strong bg-rv-c1 p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.5)]">
                <div className="mb-1 px-1.5 py-1 font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-500">
                  {t("paywalls.builder.canvas.devices", "{{platform}} devices", { platform: vm.canvasPlatform })}
                </div>
                {devicesForPlatform(vm.canvasPlatform).map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => {
                      vm.setCanvasDevice(d.id);
                      vm.setAllSizes(false);
                      setDeviceMenuOpen(false);
                    }}
                    className={cn(
                      "flex w-full cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[12px]",
                      d.id === vm.canvasDevice ? "bg-rv-c2 text-foreground" : "text-foreground hover:bg-rv-c2",
                    )}
                  >
                    <span>{d.label}</span>
                    <span className="font-rv-mono text-[10px] text-rv-mute-500">{d.w}×{d.h}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* all-sizes + safe-area chips */}
        <button
          type="button"
          onClick={() => vm.toggleAllSizes()}
          className={cn(
            "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition",
            vm.showAllSizes
              ? "border-rv-accent-500/40 bg-rv-accent-500/10 text-rv-accent-500"
              : "border-rv-divider bg-rv-c2 text-rv-mute-600 hover:bg-rv-c3 hover:text-foreground",
          )}
        >
          {t("paywalls.builder.canvas.allSizes", "All sizes")}
        </button>
        <button
          type="button"
          onClick={() => vm.toggleSafeArea()}
          className={cn(
            "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition",
            vm.showSafeArea
              ? "border-rv-accent-500/40 bg-rv-accent-500/10 text-rv-accent-500"
              : "border-rv-divider bg-rv-c2 text-rv-mute-600 hover:bg-rv-c3 hover:text-foreground",
          )}
        >
          {t("paywalls.builder.canvas.safeArea", "Safe area")}
        </button>

        <div className="ml-auto font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
          {previewBadgeText(t, priceCoverage)}
        </div>
      </div>

      <div
        ref={setViewportEl}
        onPointerDown={handleCanvasPointerDown}
        className={cn(
          "relative flex flex-1 items-center justify-center overflow-auto bg-gradient-to-b from-rv-c1 to-rv-bg p-8",
          // `select-none` while dragging — otherwise a fast pointer move
          // during the drag selects surrounding page text as a side effect.
          isCanvasDragging && "cursor-grabbing select-none",
        )}
      >
        {!vm.showAllSizes && (
          <DeviceFrame
            spec={spec}
            scale={zoom}
            scheme={vm.colorScheme}
            showSafeArea={vm.showSafeArea}
            screenBackground={screenBackground}
          >
            {renderPaywall(SINGLE_FRAME_ID)}
          </DeviceFrame>
        )}

        {vm.showAllSizes && (
          <div className="flex items-start gap-6">
            {devicesForPlatform(vm.canvasPlatform).map((d) => (
              <DeviceFrame
                key={d.id}
                spec={d}
                scale={ALL_SIZES_SCALE}
                scheme={vm.colorScheme}
                showSafeArea={vm.showSafeArea}
                screenBackground={screenBackground}
                label
              >
                {renderPaywall(d.id)}
              </DeviceFrame>
            ))}
          </div>
        )}

        {/* Selection chrome is a single-frame affordance: all-sizes repeats
            every node id across N frames, and the lookup takes the FIRST
            match, so it would land on a different frame than the one
            clicked. Selection itself still works (the properties panel
            edits the right node).

            The outline is a crisp 1px solid border drawn EXACTLY on the
            node's bounding box (`box-border` keeps the border INSIDE that
            box rather than adding to it, so it stays pixel-exact at every
            zoom level) — no ring glow, no offset gap, square corners (the
            node's own corner radius already shows inside it). The div
            itself is `pointer-events-none` so it never intercepts
            clicks/drags over the node body; only the handle squares below
            opt back in with `pointer-events-auto`, and — being absolutely
            positioned — this same box IS the containing block they
            position against, so they always land exactly on ITS corners. */}
        {ring && !vm.showAllSizes && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute box-border border border-rv-accent-500"
            style={{ left: ring.left, top: ring.top, width: ring.width, height: ring.height }}
          >
            {selectedNodeResizable &&
              RESIZE_HANDLES.map(({ corner, cursor, insetX, insetY }) => (
                <div
                  key={corner}
                  data-testid={`canvas-resize-handle-${corner}`}
                  onPointerDown={handleResizePointerDown(corner)}
                  className={cn(
                    "absolute size-2 border border-rv-accent-500 bg-white pointer-events-auto",
                    cursor,
                  )}
                  style={{
                    [insetX]: -RESIZE_HANDLE_HALF_PX,
                    [insetY]: -RESIZE_HANDLE_HALF_PX,
                    boxShadow: RESIZE_HANDLE_SHADOW,
                  }}
                />
              ))}
            {/* Live "W × H" dimension badge — node px, shown only while a
                resize is in progress (mirrors every design tool's resize
                readout). */}
            {resizeDims && (
              <div
                aria-hidden="true"
                data-testid="canvas-resize-badge"
                className="pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-rv-divider-strong bg-rv-c1 px-1.5 py-0.5 font-rv-mono text-[10px] text-rv-mute-600"
                style={{ top: ring.height + RESIZE_BADGE_GAP_PX }}
              >
                {resizeDims.width} × {resizeDims.height}
              </div>
            )}
          </div>
        )}

        {/* Canvas drag overlay (Part 2) — a dashed outline over the drag
            SOURCE's rect (captured once, at threshold-cross time) plus
            either an insertion line ("before"/"after") or an inset ring
            ("into") over the currently-resolved LEGAL drop target. Unlike
            the selection ring above, this is safe in All-sizes too: every
            rect here comes straight off the specific DOM element the
            pointer is over, never from an ambiguous by-id lookup. */}
        {dragSourceRect && isCanvasDragging && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute rounded-sm border-2 border-dashed border-rv-accent-500/70"
            style={{
              left: dragSourceRect.left,
              top: dragSourceRect.top,
              width: dragSourceRect.width,
              height: dragSourceRect.height,
            }}
          />
        )}
        {dropPreview && dropPreview.resolution.zone === "into" && (
          <div
            aria-hidden="true"
            data-testid="canvas-drop-into"
            className="pointer-events-none absolute rounded-sm ring-2 ring-inset ring-rv-accent-500 bg-rv-accent-500/10"
            style={{
              left: dropPreview.rect.left,
              top: dropPreview.rect.top,
              width: dropPreview.rect.width,
              height: dropPreview.rect.height,
            }}
          />
        )}
        {dropPreview && dropPreview.resolution.zone !== "into" && (
          <div
            aria-hidden="true"
            data-testid="canvas-drop-line"
            className="pointer-events-none absolute rounded-full bg-rv-accent-500"
            style={insertionLineStyle(dropPreview)}
          />
        )}
      </div>
    </div>
  );
});
