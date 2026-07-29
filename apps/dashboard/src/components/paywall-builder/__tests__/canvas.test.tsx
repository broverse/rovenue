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
  kind: "pointerdown" | "pointermove" | "pointerup",
  target: EventTarget,
  init: { clientX: number; clientY: number; button?: number },
) {
  const event = new Event(kind, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { value: init.clientX, configurable: true });
  Object.defineProperty(event, "clientY", { value: init.clientY, configurable: true });
  Object.defineProperty(event, "button", { value: init.button ?? 0, configurable: true });
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
});
