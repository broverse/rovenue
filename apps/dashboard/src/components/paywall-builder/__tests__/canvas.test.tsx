import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ServiceProvider, useService } from "impair";
import { emptyBuilderConfig, type BuilderConfig, type PaywallNode } from "@rovenue/shared/paywall";
import "../../../i18n/config";
import { Canvas } from "../canvas";
import { CANVAS_DRAG_THRESHOLD_PX } from "../canvas-drag";
import { PaywallBuilderApi, type PaywallBuilderDetailDto } from "../../../lib/services/paywall-builder-api";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";

// =============================================================
// Part 2 of paywall-builder drag-and-drop: dragging elements directly
// inside the device mockup canvas. This is the integration layer over
// `canvas-drag.test.ts`'s pure zone/legality unit tests — it mounts the
// REAL `Canvas` (real VM, real `@rovenue/paywall-renderer` output) and
// drives the actual pointerdown/pointermove/pointerup wiring in
// canvas.tsx, asserting on `vm.config` (state-based — spying on the VM
// proxy doesn't work, same idiom `tree-ops.test.ts`/`layer-tree.test.tsx`
// use for Part 1).
//
// jsdom has no `document.elementsFromPoint` at all, so it's stubbed per
// test to return exactly the candidate elements a real hit-test would
// find at the simulated pointer position, deepest-first. Every node's
// `getBoundingClientRect` is stubbed too (jsdom's default is all-zero),
// giving each fixture node a real, distinct rect so a pointer position
// can land in a specific band deterministically — mirrors
// `layer-tree.test.tsx`'s rect-stubbing approach for Part 1.
// =============================================================

const productsGet = vi.hoisted(() => vi.fn());
const resolvedGet = vi.hoisted(() => vi.fn());
const apiFn = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/api")>();
  return {
    ...actual,
    api: apiFn,
    rpc: {
      dashboard: {
        projects: {
          ":projectId": {
            products: { $get: productsGet },
            offerings: { ":id": { resolved: { $get: resolvedGet } } },
          },
        },
      },
    },
    unwrap: async (p: Promise<unknown>) => p,
  };
});

function fixtureConfig(): BuilderConfig {
  // root (stack v)
  //   leafA (text)
  //   leafB (text)
  //   rowContainer (stack h)
  //     rowChild1 (text)
  //     rowChild2 (text)
  const config = emptyBuilderConfig("en");
  const leafA: PaywallNode = { type: "text", id: "leafA", key: "kA", role: "body" };
  const leafB: PaywallNode = { type: "text", id: "leafB", key: "kB", role: "body" };
  const rowChild1: PaywallNode = { type: "text", id: "rowChild1", key: "kC1", role: "body" };
  const rowChild2: PaywallNode = { type: "text", id: "rowChild2", key: "kC2", role: "body" };
  const rowContainer: PaywallNode = {
    type: "stack",
    id: "rowContainer",
    axis: "h",
    children: [rowChild1, rowChild2],
  };
  config.root.children.push(leafA, leafB, rowContainer);
  // Text nodes with no localization entry for their `key` render NOTHING
  // (`renderText` in the renderer returns null / its fallback) — every
  // fixture leaf needs a real string here or its `[data-rov-node]` div
  // never reaches the DOM at all.
  config.localizations.en = { kA: "Leaf A", kB: "Leaf B", kC1: "Row child 1", kC2: "Row child 2" };
  return config;
}

function fakeDetail(config: BuilderConfig): PaywallBuilderDetailDto {
  return {
    id: "pw_1",
    projectId: "p_1",
    identifier: "main",
    name: "Main paywall",
    offeringId: "off_1",
    isActive: true,
    configFormatVersion: 2,
    draftRevision: 0,
    builderConfig: config,
    defaultLocale: "en",
    offeringPackageIds: [],
    updatedAt: "",
    createdAt: "",
    status: "draft",
    publishedVersionId: null,
  };
}

async function renderCanvas(config: BuilderConfig = fixtureConfig()) {
  vi.spyOn(PaywallBuilderApi.prototype, "get").mockResolvedValue(fakeDetail(config));

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  let vm!: PaywallBuilderViewModel;
  function Probe() {
    vm = useService(PaywallBuilderViewModel);
    return null;
  }

  const utils = render(
    <QueryClientProvider client={qc}>
      <ServiceProvider
        provide={[PaywallBuilderApi, PaywallBuilderViewModel]}
        props={{ projectId: "p_1", paywallId: "pw_1" }}
      >
        <Probe />
        <Canvas />
      </ServiceProvider>
    </QueryClientProvider>,
  );

  await act(async () => {
    await vm.load(() => {});
  });

  return { vm, ...utils };
}

/** Stubs one element's `getBoundingClientRect` to a fixed, distinct rect. */
function stubRect(el: Element, rect: { left: number; top: number; width: number; height: number }) {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON() {
        return this;
      },
    }),
  });
}

function nodeEl(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-rov-node="${id}"]`);
  if (!el) throw new Error(`expected a [data-rov-node="${id}"] element`);
  return el;
}

/** `PointerEvent` fields beyond a plain `MouseEvent` (`clientX`/`clientY`
 * included) don't always survive jsdom's event constructors reliably, so
 * (mirroring `layer-tree.test.tsx`'s `fireDnd` workaround for `clientY`)
 * every field is stamped on by hand after construction. */
function firePointer(
  kind: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  target: EventTarget,
  init: { clientX: number; clientY: number; button?: number; pointerId?: number },
) {
  const event = new Event(kind, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { value: init.clientX, configurable: true });
  Object.defineProperty(event, "clientY", { value: init.clientY, configurable: true });
  Object.defineProperty(event, "button", { value: init.button ?? 0, configurable: true });
  // Defaults to a single stable pointer (1) so every existing call site
  // (single-pointer drags) keeps working unchanged; re-entrancy tests pass
  // a distinct id for the SECOND, stray pointer.
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1, configurable: true });
  // Dispatched directly (not via RTL's `fireEvent`, which has no
  // `pointerdown`-family awareness beyond what jsdom's `Event` already
  // gives it here) — wrap in `act` ourselves so the resulting state
  // updates (drag state, `vm.moveNodeTo`) are flushed synchronously.
  act(() => {
    target.dispatchEvent(event);
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  productsGet.mockResolvedValue({ products: [] });
  resolvedGet.mockResolvedValue({ packages: [] });
  apiFn.mockResolvedValue({ offering: { identifier: "off_1", packages: [] } });
  document.elementsFromPoint = vi.fn().mockReturnValue([]);
});

describe("Canvas — drag-and-drop inside the device mockup (Part 2)", () => {
  it("reorders a sibling via a before-band drop, mirroring the Layers panel's semantics", async () => {
    const { vm, container } = await renderCanvas();

    const leafA = nodeEl(container, "leafA");
    const leafB = nodeEl(container, "leafB");
    // root is a vertical stack: leafA occupies the top half, leafB the
    // bottom half of a shared 200x100 area.
    stubRect(leafA, { left: 0, top: 0, width: 200, height: 50 });
    stubRect(leafB, { left: 0, top: 50, width: 200, height: 50 });

    // Drag leafB up onto leafA's TOP band ("before").
    firePointer("pointerdown", leafB, { clientX: 100, clientY: 75 });
    // Past the threshold, but elementsFromPoint isn't queried until the
    // pointer crosses it — first move stays put to arm the drag.
    firePointer("pointermove", document, { clientX: 100, clientY: 75 + CANVAS_DRAG_THRESHOLD_PX + 1 });
    (document.elementsFromPoint as ReturnType<typeof vi.fn>).mockReturnValue([leafA]);
    // ratio (10 - 0) / 50 = 0.2 -> "before" on a non-container leaf.
    firePointer("pointermove", document, { clientX: 100, clientY: 10 });
    firePointer("pointerup", document, { clientX: 100, clientY: 10 });

    expect(vm.config.root.children.map((c) => c.id)).toEqual(["leafB", "leafA", "rowContainer"]);
    // The dragged node stays selected after a successful move.
    expect(vm.selectedNodeId).toBe("leafB");
  });

  it("splits before/after along a HORIZONTAL parent's X axis, not Y", async () => {
    const { vm, container } = await renderCanvas();

    const rowChild1 = nodeEl(container, "rowChild1");
    const rowChild2 = nodeEl(container, "rowChild2");
    // rowContainer is a horizontal stack: its two children sit side by
    // side, sharing the same vertical band.
    stubRect(rowChild1, { left: 0, top: 0, width: 50, height: 100 });
    stubRect(rowChild2, { left: 50, top: 0, width: 50, height: 100 });

    // Drag rowChild2 onto rowChild1's LEFT edge (x ratio 0.1 -> "before"),
    // at a y that would say "after" on a vertical split — proving the
    // horizontal parent axis, not a default Y split, drove the outcome.
    firePointer("pointerdown", rowChild2, { clientX: 60, clientY: 90 });
    firePointer("pointermove", document, { clientX: 60 + CANVAS_DRAG_THRESHOLD_PX + 1, clientY: 90 });
    (document.elementsFromPoint as ReturnType<typeof vi.fn>).mockReturnValue([rowChild1]);
    firePointer("pointermove", document, { clientX: 5, clientY: 90 });
    firePointer("pointerup", document, { clientX: 5, clientY: 90 });

    const row = vm.config.root.children.find((n) => n.id === "rowContainer");
    if (row?.type !== "stack") throw new Error("expected the rowContainer fixture");
    expect(row.children.map((c) => c.id)).toEqual(["rowChild2", "rowChild1"]);
  });

  it("cancels the drag on Escape, leaving the tree untouched", async () => {
    const { vm, container } = await renderCanvas();
    const configBefore = vm.config;

    const leafA = nodeEl(container, "leafA");
    const leafB = nodeEl(container, "leafB");
    stubRect(leafA, { left: 0, top: 0, width: 200, height: 50 });
    stubRect(leafB, { left: 0, top: 50, width: 200, height: 50 });

    firePointer("pointerdown", leafB, { clientX: 100, clientY: 75 });
    firePointer("pointermove", document, { clientX: 100, clientY: 75 + CANVAS_DRAG_THRESHOLD_PX + 1 });
    (document.elementsFromPoint as ReturnType<typeof vi.fn>).mockReturnValue([leafA]);
    firePointer("pointermove", document, { clientX: 100, clientY: 10 });

    fireEvent.keyDown(document, { key: "Escape" });
    firePointer("pointerup", document, { clientX: 100, clientY: 10 });

    expect(vm.config).toBe(configBefore);
  });

  it("does nothing when the pointer never crosses the drag threshold (plain click still selects)", async () => {
    const { vm, container } = await renderCanvas();
    const configBefore = vm.config;

    const leafA = nodeEl(container, "leafA");
    stubRect(leafA, { left: 0, top: 0, width: 200, height: 50 });

    firePointer("pointerdown", leafA, { clientX: 100, clientY: 25 });
    // Movement stays UNDER the threshold the whole time.
    firePointer("pointermove", document, { clientX: 100, clientY: 25 + CANVAS_DRAG_THRESHOLD_PX - 1 });
    firePointer("pointerup", document, { clientX: 100, clientY: 25 + CANVAS_DRAG_THRESHOLD_PX - 1 });
    fireEvent.click(leafA);

    expect(vm.config).toBe(configBefore); // no tree mutation
    expect(vm.selectedNodeId).toBe("leafA"); // but selection still works
  });

  // ===========================================================
  // Fix round 1 — pointerdown re-entrancy leak: a second pointerdown
  // arriving before the first drag's pointerup/pointercancel/Escape (two
  // fingers, or a stylus and a finger both down) used to overwrite
  // `dragRef`/`dragCleanupRef`, silently orphaning the first drag's four
  // document listeners forever (nothing else retained that closure).
  // `handleCanvasPointerDown` now ignores a pointerdown while a drag is
  // already armed, and every pointermove/pointerup/pointercancel checks
  // its OWN `pointerId` against the armed one.
  // ===========================================================
  it("ignores a second pointerdown while a drag is already armed — the original drag still completes", async () => {
    const { vm, container } = await renderCanvas();

    const leafA = nodeEl(container, "leafA");
    const leafB = nodeEl(container, "leafB");
    stubRect(leafA, { left: 0, top: 0, width: 200, height: 50 });
    stubRect(leafB, { left: 0, top: 50, width: 200, height: 50 });

    // Pointer 1 arms a drag on leafB, past the threshold.
    firePointer("pointerdown", leafB, { clientX: 100, clientY: 75, pointerId: 1 });
    firePointer("pointermove", document, {
      clientX: 100,
      clientY: 75 + CANVAS_DRAG_THRESHOLD_PX + 1,
      pointerId: 1,
    });

    // A second, distinct pointer (id 2) presses down on a DIFFERENT node
    // mid-drag — must be a complete no-op: no new drag armed for leafA,
    // pointer 1's drag untouched.
    firePointer("pointerdown", leafA, { clientX: 100, clientY: 10, pointerId: 2 });

    // Pointer 1 continues and completes the ORIGINAL drag exactly as the
    // very first test does.
    (document.elementsFromPoint as ReturnType<typeof vi.fn>).mockReturnValue([leafA]);
    firePointer("pointermove", document, { clientX: 100, clientY: 10, pointerId: 1 });
    firePointer("pointerup", document, { clientX: 100, clientY: 10, pointerId: 1 });

    expect(vm.config.root.children.map((c) => c.id)).toEqual(["leafB", "leafA", "rowContainer"]);
    expect(vm.selectedNodeId).toBe("leafB");
  });

  it("ignores a pointerup/pointercancel from a stray pointer that didn't start the drag", async () => {
    const { vm, container } = await renderCanvas();
    const configBefore = vm.config;

    const leafA = nodeEl(container, "leafA");
    const leafB = nodeEl(container, "leafB");
    stubRect(leafA, { left: 0, top: 0, width: 200, height: 50 });
    stubRect(leafB, { left: 0, top: 50, width: 200, height: 50 });

    firePointer("pointerdown", leafB, { clientX: 100, clientY: 75, pointerId: 1 });
    firePointer("pointermove", document, {
      clientX: 100,
      clientY: 75 + CANVAS_DRAG_THRESHOLD_PX + 1,
      pointerId: 1,
    });

    // A stray pointer 2 ending (or cancelling) must NOT tear down pointer
    // 1's still-in-progress drag.
    firePointer("pointerup", document, { clientX: 999, clientY: 999, pointerId: 2 });
    firePointer("pointercancel", document, { clientX: 999, clientY: 999, pointerId: 2 });
    expect(vm.config).toBe(configBefore); // drag 1 wasn't ended by either

    // Pointer 1 itself still completes the drag correctly afterwards.
    (document.elementsFromPoint as ReturnType<typeof vi.fn>).mockReturnValue([leafA]);
    firePointer("pointermove", document, { clientX: 100, clientY: 10, pointerId: 1 });
    firePointer("pointerup", document, { clientX: 100, clientY: 10, pointerId: 1 });

    expect(vm.config.root.children.map((c) => c.id)).toEqual(["leafB", "leafA", "rowContainer"]);
  });

  it("adds and removes exactly one set of document listeners per drag, even with a re-entrant pointerdown", async () => {
    const { container } = await renderCanvas();

    const leafA = nodeEl(container, "leafA");
    const leafB = nodeEl(container, "leafB");
    stubRect(leafA, { left: 0, top: 0, width: 200, height: 50 });
    stubRect(leafB, { left: 0, top: 50, width: 200, height: 50 });

    const EVENT_NAMES = ["pointermove", "pointerup", "pointercancel", "keydown"] as const;
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const countCalls = (spy: typeof addSpy, name: string) =>
      spy.mock.calls.filter(([eventName]) => eventName === name).length;

    firePointer("pointerdown", leafB, { clientX: 100, clientY: 75, pointerId: 1 });
    firePointer("pointermove", document, {
      clientX: 100,
      clientY: 75 + CANVAS_DRAG_THRESHOLD_PX + 1,
      pointerId: 1,
    });
    for (const name of EVENT_NAMES) expect(countCalls(addSpy, name)).toBe(1);

    // The re-entrant pointerdown must add NOTHING — still exactly one
    // listener per event type, proving it was ignored outright rather
    // than adding a second (leaked) set on top of the first.
    firePointer("pointerdown", leafA, { clientX: 100, clientY: 10, pointerId: 2 });
    for (const name of EVENT_NAMES) expect(countCalls(addSpy, name)).toBe(1);

    (document.elementsFromPoint as ReturnType<typeof vi.fn>).mockReturnValue([leafA]);
    firePointer("pointermove", document, { clientX: 100, clientY: 10, pointerId: 1 });
    firePointer("pointerup", document, { clientX: 100, clientY: 10, pointerId: 1 });

    // Cleanup ran exactly once — one matching `removeEventListener` per
    // event type, not zero (leaked) and not more than one (double-cleanup).
    for (const name of EVENT_NAMES) expect(countCalls(removeSpy, name)).toBe(1);
  });
});

// =============================================================
// Selection chrome — corner-drag resize. `rowContainer` (a `stack`) is the
// fixture's only node whose schema carries a `size` box (see
// `isResizableNode` in canvas-helpers.ts); the leaf `text` nodes exercise
// the "no handles for this node type" gate. The viewport/scroll-container
// rect is left at jsdom's default (all-zero, unscrolled), so
// `computeSelectionRect`'s chrome-coordinate transform is a no-op and the
// selection/resize math lines up directly with each stubbed node rect.
// =============================================================

describe("Canvas — selection chrome corner resize", () => {
  it("renders no resize handles for a node whose schema has no `size` field", async () => {
    const { vm, container } = await renderCanvas();
    const leafA = nodeEl(container, "leafA");
    stubRect(leafA, { left: 0, top: 0, width: 200, height: 50 });

    await act(async () => {
      vm.selectNode("leafA");
    });

    expect(container.querySelector('[data-testid^="canvas-resize-handle-"]')).toBeNull();
  });

  it("renders all four corner handles for a selected stack node", async () => {
    const { vm, container } = await renderCanvas();
    const rowContainer = nodeEl(container, "rowContainer");
    stubRect(rowContainer, { left: 100, top: 50, width: 80, height: 40 });

    await act(async () => {
      vm.selectNode("rowContainer");
    });

    for (const corner of ["tl", "tr", "bl", "br"]) {
      expect(container.querySelector(`[data-testid="canvas-resize-handle-${corner}"]`)).not.toBeNull();
    }
  });

  it("mid-gesture: tracks the live badge WITHOUT touching the VM, then commits exactly once on release", async () => {
    const { vm, container } = await renderCanvas();
    const rowContainer = nodeEl(container, "rowContainer");
    // 80x40 box at (100, 50) -> spans x:[100,180], y:[50,90].
    stubRect(rowContainer, { left: 100, top: 50, width: 80, height: 40 });

    await act(async () => {
      vm.selectNode("rowContainer");
    });
    const configBeforeSelect = vm.config;

    const handle = container.querySelector<HTMLElement>('[data-testid="canvas-resize-handle-br"]');
    if (!handle) throw new Error("expected a br resize handle");

    // "br" anchors at the OPPOSITE corner, top-left (100, 50). Dragging to
    // (150, 130) -> width |150-100|=50, height |130-50|=80 (zoom is 1).
    firePointer("pointerdown", handle, { clientX: 180, clientY: 90 });
    firePointer("pointermove", document, { clientX: 150, clientY: 130 });

    // MID-GESTURE: the VM must be untouched — a live per-pointermove write
    // would remount the whole PaywallRenderer subtree every frame (mount-
    // time state: countdown timers, carousel page, media elements). Only
    // the local overlay/badge reflects the drag.
    expect(vm.config).toBe(configBeforeSelect);
    expect(container.querySelector('[data-testid="canvas-resize-badge"]')?.textContent).toBe("50 × 80");

    firePointer("pointerup", document, { clientX: 150, clientY: 130 });

    // On release: exactly one commit, with the final {width, height}.
    const row = vm.config.root.children.find((n) => n.id === "rowContainer");
    if (row?.type !== "stack") throw new Error("expected the rowContainer fixture");
    expect(row.size).toEqual({ width: 50, height: 80 });
    // The badge disappears once the gesture ends.
    expect(container.querySelector('[data-testid="canvas-resize-badge"]')).toBeNull();
  });

  it("drags the top-left handle, anchored at the opposite (bottom-right) corner", async () => {
    const { vm, container } = await renderCanvas();
    const rowContainer = nodeEl(container, "rowContainer");
    stubRect(rowContainer, { left: 100, top: 50, width: 80, height: 40 });

    await act(async () => {
      vm.selectNode("rowContainer");
    });

    const handle = container.querySelector<HTMLElement>('[data-testid="canvas-resize-handle-tl"]');
    if (!handle) throw new Error("expected a tl resize handle");

    // "tl" anchors at the OPPOSITE corner, bottom-right (180, 90). Dragging
    // to (60, 70) -> width |60-180|=120, height |70-90|=20.
    firePointer("pointerdown", handle, { clientX: 100, clientY: 50 });
    firePointer("pointermove", document, { clientX: 60, clientY: 70 });
    firePointer("pointerup", document, { clientX: 60, clientY: 70 });

    const row = vm.config.root.children.find((n) => n.id === "rowContainer");
    if (row?.type !== "stack") throw new Error("expected the rowContainer fixture");
    expect(row.size).toEqual({ width: 120, height: 20 });
  });

  it("cancels a resize on Escape — the VM was never touched, so there's nothing to restore", async () => {
    const { vm, container } = await renderCanvas();
    const rowContainer = nodeEl(container, "rowContainer");
    stubRect(rowContainer, { left: 100, top: 50, width: 80, height: 40 });

    await act(async () => {
      vm.selectNode("rowContainer");
    });
    const configBefore = vm.config;

    const handle = container.querySelector<HTMLElement>('[data-testid="canvas-resize-handle-br"]');
    if (!handle) throw new Error("expected a br resize handle");

    firePointer("pointerdown", handle, { clientX: 180, clientY: 90 });
    firePointer("pointermove", document, { clientX: 150, clientY: 130 });
    expect(container.querySelector('[data-testid="canvas-resize-badge"]')?.textContent).toBe("50 × 80");

    fireEvent.keyDown(document, { key: "Escape" });
    firePointer("pointerup", document, { clientX: 150, clientY: 130 });

    // Byte-identical: `vm.config` was never written to during the whole
    // gesture, so it's still the exact same reference as before it started.
    expect(vm.config).toBe(configBefore);
    const row = vm.config.root.children.find((n) => n.id === "rowContainer");
    if (row?.type !== "stack") throw new Error("expected the rowContainer fixture");
    expect(row.size).toBeUndefined();
    expect(container.querySelector('[data-testid="canvas-resize-badge"]')).toBeNull();
  });

  it("skips the commit write entirely when the pointer never actually moved the dims", async () => {
    const { vm, container } = await renderCanvas();
    const rowContainer = nodeEl(container, "rowContainer");
    stubRect(rowContainer, { left: 100, top: 50, width: 80, height: 40 });

    await act(async () => {
      vm.selectNode("rowContainer");
    });
    const configBefore = vm.config;

    const handle = container.querySelector<HTMLElement>('[data-testid="canvas-resize-handle-br"]');
    if (!handle) throw new Error("expected a br resize handle");

    // No pointermove at all between down and up — dims never change from
    // the gesture's own starting size.
    firePointer("pointerdown", handle, { clientX: 180, clientY: 90 });
    firePointer("pointerup", document, { clientX: 180, clientY: 90 });

    expect(vm.config).toBe(configBefore);
  });

  it("clamps to the minimum size when dragged past or near the anchor", async () => {
    const { vm, container } = await renderCanvas();
    const rowContainer = nodeEl(container, "rowContainer");
    stubRect(rowContainer, { left: 100, top: 50, width: 80, height: 40 });

    await act(async () => {
      vm.selectNode("rowContainer");
    });

    const handle = container.querySelector<HTMLElement>('[data-testid="canvas-resize-handle-br"]');
    if (!handle) throw new Error("expected a br resize handle");

    // Dragged almost onto the anchor (100, 50) itself.
    firePointer("pointerdown", handle, { clientX: 180, clientY: 90 });
    firePointer("pointermove", document, { clientX: 101, clientY: 51 });
    firePointer("pointerup", document, { clientX: 101, clientY: 51 });

    const row = vm.config.root.children.find((n) => n.id === "rowContainer");
    if (row?.type !== "stack") throw new Error("expected the rowContainer fixture");
    expect(row.size).toEqual({ width: 8, height: 8 });
  });
});
