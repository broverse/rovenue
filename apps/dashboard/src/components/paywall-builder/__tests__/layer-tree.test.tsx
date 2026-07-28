import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { ServiceProvider, useService } from "impair";
import {
  emptyBuilderConfig,
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
    // The popover renders inside the same row; its entries are plain buttons.
    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: pickLabel }));
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
