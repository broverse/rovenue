import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { ServiceProvider, useService } from "impair";
import {
  emptyBuilderConfig,
  MAX_BUILDER_DEPTH,
  MAX_BUILDER_NODES,
  type BuilderConfig,
  type PaywallNode,
} from "@rovenue/shared/paywall";
import "../../../i18n/config";
import { LayerTree } from "../layer-tree";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import {
  PaywallBuilderApi,
  type PaywallBuilderDetailDto,
} from "../../../lib/services/paywall-builder-api";

// =============================================================
// Wave D1 / finding C2 — the layer tree is the ONLY way an author
// puts a child inside a container, so this file drives the same
// path a person does: mount the real LayerTree over a real
// PaywallBuilderViewModel, look for the "+ Add node" affordance on
// a carousel and on a sticky footer, click through the popover, and
// read the resulting rows back off the screen.
//
// The predecessor fix taught why this file has to exist: tree-ops'
// `isContainerNode` already knew about carousel/stickyFooter and its
// unit tests were green, while the button that calls `insertNode`
// was still gated on `type === "stack"` — so nothing an author could
// see had changed. Asserting on `insertNode` is therefore explicitly
// NOT enough here; every assertion below goes through the DOM.
// =============================================================

/** Title text of the add affordance (i18n fallback for `…layers.add`). */
const ADD_NODE_TITLE = "Add node";
/** Row labels, from NODE_TYPE_LABEL — the layer row's own visible text. */
const LABEL_STACK = "Stack";
const LABEL_CAROUSEL = "Carousel";
const LABEL_STICKY_FOOTER = "Sticky footer";
const LABEL_IMAGE = "Image";
const LABEL_DIVIDER = "Divider";
const LABEL_PURCHASE_BUTTON = "Purchase button";
const LABEL_TEXT = "Text";

// Fixture tree:
// root (stack v)
//   car1 (carousel)
//     page_img (image)          <- a carousel page
//   sf1 (stickyFooter)
//     sf_divider (divider)      <- a sticky-footer child
function fixtureConfig(): BuilderConfig {
  const config = emptyBuilderConfig("en");
  const carousel: PaywallNode = {
    type: "carousel",
    id: "car1",
    children: [{ type: "image", id: "page_img", url: { light: "https://x/y.png" } }],
  };
  const stickyFooter: PaywallNode = {
    type: "stickyFooter",
    id: "sf1",
    children: [{ type: "divider", id: "sf_divider" }],
  };
  config.root.children.push(carousel, stickyFooter);
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

async function renderLayerTree(config: BuilderConfig = fixtureConfig()) {
  vi.spyOn(PaywallBuilderApi.prototype, "get").mockResolvedValue(fakeDetail(config));

  let vm!: PaywallBuilderViewModel;
  function Probe() {
    vm = useService(PaywallBuilderViewModel);
    return null;
  }

  const utils = render(
    <ServiceProvider
      provide={[PaywallBuilderApi, PaywallBuilderViewModel]}
      props={{ projectId: "p_1", paywallId: "pw_1" }}
    >
      <Probe />
      <LayerTree />
    </ServiceProvider>,
  );

  await act(async () => {
    await vm.load(() => {});
  });

  return { vm, ...utils };
}

/**
 * The layer row element for a node with the given visible label. Walks up
 * from the label span through its select button to the row container, so
 * the query never depends on a styling class.
 */
function rowByLabel(label: string): HTMLElement {
  const labelSpan = screen.getByText(label);
  const row = labelSpan.closest("button")?.parentElement;
  if (!row) throw new Error(`No layer row found for label "${label}"`);
  return row as HTMLElement;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("LayerTree — container add affordance (finding C2)", () => {
  it("offers '+ Add node' on a stack, as it always did", async () => {
    await renderLayerTree();
    expect(within(rowByLabel(LABEL_STACK)).queryByTitle(ADD_NODE_TITLE)).not.toBeNull();
  });

  it("offers '+ Add node' on a carousel", async () => {
    await renderLayerTree();
    expect(within(rowByLabel(LABEL_CAROUSEL)).queryByTitle(ADD_NODE_TITLE)).not.toBeNull();
  });

  it("offers '+ Add node' on a sticky footer", async () => {
    await renderLayerTree();
    expect(within(rowByLabel(LABEL_STICKY_FOOTER)).queryByTitle(ADD_NODE_TITLE)).not.toBeNull();
  });

  it("does NOT offer '+ Add node' on a leaf node", async () => {
    await renderLayerTree();
    expect(within(rowByLabel(LABEL_IMAGE)).queryByTitle(ADD_NODE_TITLE)).toBeNull();
  });
});

describe("LayerTree — container children are rows (finding C2)", () => {
  it("shows a carousel's page as its own row", async () => {
    await renderLayerTree();
    expect(screen.queryByText(LABEL_IMAGE)).not.toBeNull();
  });

  it("shows a sticky footer's child as its own row", async () => {
    await renderLayerTree();
    expect(screen.queryByText(LABEL_DIVIDER)).not.toBeNull();
  });

  it("indents container children one level below their container", async () => {
    await renderLayerTree();
    const paddingOf = (label: string) => rowByLabel(label).style.paddingLeft;
    // paddingLeft is `10 + depth * 14`px — carousel/stickyFooter sit at
    // depth 1 (24px) and their children at depth 2 (38px).
    expect(paddingOf(LABEL_CAROUSEL)).toBe("24px");
    expect(paddingOf(LABEL_IMAGE)).toBe("38px");
    expect(paddingOf(LABEL_STICKY_FOOTER)).toBe("24px");
    expect(paddingOf(LABEL_DIVIDER)).toBe("38px");
  });

  it("gives container children the move and delete controls", async () => {
    await renderLayerTree();
    for (const label of [LABEL_IMAGE, LABEL_DIVIDER]) {
      const row = within(rowByLabel(label));
      expect(row.queryByTitle("Move up")).not.toBeNull();
      expect(row.queryByTitle("Move down")).not.toBeNull();
      expect(row.queryByTitle("Delete")).not.toBeNull();
    }
  });
});

describe("LayerTree — adding through the UI path (finding C2)", () => {
  /** Clicks the add affordance on `label`'s row, then picks `pickLabel` from the popover. */
  async function addVia(label: string, pickLabel: string) {
    // Resolve the row BEFORE opening the popover: the popover lists every
    // node type, so once it's open `label` matches its menu entry too.
    const row = rowByLabel(label);
    await act(async () => {
      fireEvent.click(within(row).getByTitle(ADD_NODE_TITLE));
    });
    // The popover portals to `document.body` (BUG 1 fix — it must escape
    // the Layers aside's own `overflow-y-auto` clipping), so it's no
    // longer a descendant of `row`; query the full document instead.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: pickLabel }));
    });
  }

  it("places a purchase button inside a sticky footer — the footer's whole purpose", async () => {
    const { vm } = await renderLayerTree();
    expect(screen.queryByText(LABEL_PURCHASE_BUTTON)).toBeNull();

    await addVia(LABEL_STICKY_FOOTER, LABEL_PURCHASE_BUTTON);

    // Visible to the author…
    expect(screen.queryByText(LABEL_PURCHASE_BUTTON)).not.toBeNull();
    // …and actually parented on the sticky footer, not dropped at the root.
    const footer = vm.config.root.children.find((n) => n.id === "sf1");
    if (footer?.type !== "stickyFooter") throw new Error("expected the stickyFooter fixture");
    expect(footer.children.map((c) => c.type)).toEqual(["divider", "purchaseButton"]);
  });

  it("places a page inside a carousel", async () => {
    const { vm } = await renderLayerTree();
    expect(screen.queryByText(LABEL_TEXT)).toBeNull();

    await addVia(LABEL_CAROUSEL, LABEL_TEXT);

    expect(screen.queryByText(LABEL_TEXT)).not.toBeNull();
    const carousel = vm.config.root.children.find((n) => n.id === "car1");
    if (carousel?.type !== "carousel") throw new Error("expected the carousel fixture");
    expect(carousel.children.map((c) => c.type)).toEqual(["image", "text"]);
  });

  it("removes a carousel page through its row's delete control", async () => {
    const { vm } = await renderLayerTree();
    const del = within(rowByLabel(LABEL_IMAGE)).getByTitle("Delete");
    await act(async () => {
      fireEvent.click(del);
    });

    expect(screen.queryByText(LABEL_IMAGE)).toBeNull();
    const carousel = vm.config.root.children.find((n) => n.id === "car1");
    if (carousel?.type !== "carousel") throw new Error("expected the carousel fixture");
    expect(carousel.children).toEqual([]);
  });
});

/** A flat tree with `childCount` spacer leaves under the root — enough of them trips `vm.atNodeCapacity`. */
function flatWideFixtureConfig(childCount: number): BuilderConfig {
  const config = emptyBuilderConfig("en");
  const children: PaywallNode[] = Array.from({ length: childCount }, (_, i) => ({
    type: "spacer",
    id: `sp${i}`,
    size: 8,
  }));
  config.root.children.push(...children);
  return config;
}

/**
 * A single chain of `depth` nested stacks under the root (root itself is
 * depth 0), so the innermost stack — id `d${depth - 1}` — sits at exactly
 * `depth` in the layer tree's own depth numbering.
 */
function deepFixtureConfig(depth: number): BuilderConfig {
  const config = emptyBuilderConfig("en");
  let node: PaywallNode = { type: "stack", id: `d${depth - 1}`, axis: "v", children: [] };
  for (let i = depth - 2; i >= 0; i--) {
    node = { type: "stack", id: `d${i}`, axis: "v", children: [node] };
  }
  config.root.children.push(node);
  return config;
}

// =============================================================
// BUG 2 / FEATURE — adding elements used to depend entirely on hovering a
// container row's own "+", which is invisible until you find one. This
// button is pinned under the panel header (always visible, no hover
// hunting) and resolves its own insert target from the current selection
// via `resolveAddTargetId` (unit-covered separately in tree-ops.test.ts) —
// these tests drive it through the DOM the same way the C2 file above
// drives the per-row "+", per this file's own lesson: asserting on the
// pure helper alone would have missed the button never being wired to it.
// =============================================================
describe("LayerTree — 'New Element' button (BUG 2 / feature)", () => {
  const NEW_ELEMENT_LABEL = "New Element";
  const TITLE_AT_NODE_CAPACITY = "This paywall has reached the maximum number of elements.";
  const TITLE_AT_DEPTH_CAPACITY = "This branch is nested too deeply to add another element.";

  it("renders a persistent button, visible without hovering any row", async () => {
    await renderLayerTree();
    expect(screen.getByRole("button", { name: NEW_ELEMENT_LABEL })).not.toBeNull();
  });

  it("falls back to the root when nothing is selected", async () => {
    const { vm } = await renderLayerTree();
    expect(screen.queryByText(LABEL_TEXT)).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: NEW_ELEMENT_LABEL }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: LABEL_TEXT }));
    });

    expect(screen.queryByText(LABEL_TEXT)).not.toBeNull();
    expect(vm.config.root.children.map((c) => c.type)).toEqual(["carousel", "stickyFooter", "text"]);
  });

  it("inserts into the selected container, not the root", async () => {
    const { vm } = await renderLayerTree();

    await act(async () => {
      vm.selectNode("sf1");
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: NEW_ELEMENT_LABEL }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: LABEL_PURCHASE_BUTTON }));
    });

    const footer = vm.config.root.children.find((n) => n.id === "sf1");
    if (footer?.type !== "stickyFooter") throw new Error("expected the stickyFooter fixture");
    expect(footer.children.map((c) => c.type)).toEqual(["divider", "purchaseButton"]);
    // Not dropped at the root alongside it.
    expect(vm.config.root.children.map((c) => c.id)).toEqual(["car1", "sf1"]);
  });

  it("disables the button and shows the node-capacity title when the tree is at capacity", async () => {
    await renderLayerTree(flatWideFixtureConfig(MAX_BUILDER_NODES));
    const button = screen.getByRole("button", { name: NEW_ELEMENT_LABEL }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(TITLE_AT_NODE_CAPACITY);
  });

  it("disables the button and shows the depth-capacity title when the resolved target is too deep", async () => {
    const targetDepth = MAX_BUILDER_DEPTH - 1;
    const { vm } = await renderLayerTree(deepFixtureConfig(targetDepth));
    await act(async () => {
      vm.selectNode(`d${targetDepth - 1}`);
    });
    const button = screen.getByRole("button", { name: NEW_ELEMENT_LABEL }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(TITLE_AT_DEPTH_CAPACITY);
  });

  it("stays enabled comfortably below the depth cap", async () => {
    await renderLayerTree(deepFixtureConfig(MAX_BUILDER_DEPTH - 10));
    const button = screen.getByRole("button", { name: NEW_ELEMENT_LABEL }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});

// =============================================================
// BUG 1 regression — the palette used to be `absolute`-positioned inside
// a `relative` wrapper nested in this aside's own `overflow-y-auto` rows
// area. Per the CSS overflow model, that clips ANY descendant regardless
// of its own `position` (fixed included) — a portal to `document.body` is
// the only fix that holds regardless of anchor or scroll state. This test
// pins that: if the popover ever goes back to rendering as a plain nested
// element, it will start failing (`aside.contains(heading)` flips true).
// =============================================================
describe("LayerTree — add-node popover portal (BUG 1 regression)", () => {
  it("renders the palette outside the Layers aside, via a portal to document.body", async () => {
    const { baseElement } = await renderLayerTree();

    const row = rowByLabel(LABEL_STACK);
    await act(async () => {
      fireEvent.click(within(row).getByTitle(ADD_NODE_TITLE));
    });

    const aside = baseElement.querySelector("aside");
    if (!aside) throw new Error("expected the Layers aside to be in the document");
    const heading = screen.getByText("Add node");

    expect(aside.contains(heading)).toBe(false);
    expect(baseElement.contains(heading)).toBe(true);
  });

  it("renders the 'New Element' button's palette outside the aside too", async () => {
    const { baseElement } = await renderLayerTree();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New Element" }));
    });

    const aside = baseElement.querySelector("aside");
    if (!aside) throw new Error("expected the Layers aside to be in the document");
    const heading = screen.getByText("Add node");

    expect(aside.contains(heading)).toBe(false);
    expect(baseElement.contains(heading)).toBe(true);
  });
});
