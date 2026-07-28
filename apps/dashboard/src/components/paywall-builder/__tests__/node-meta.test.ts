import { describe, expect, it } from "vitest";
import type { PaywallNode } from "@rovenue/shared/paywall";
import { NODE_ICON, NODE_TYPE_LABEL, NODE_TYPES, nodeLocKey } from "../node-meta";

describe("nodeLocKey", () => {
  it("returns the `key` for text nodes", () => {
    const node: PaywallNode = { type: "text", id: "t1", key: "hero_title", role: "title" };
    expect(nodeLocKey(node)).toBe("hero_title");
  });

  it("returns the `labelKey` for button and purchaseButton nodes", () => {
    const button: PaywallNode = {
      type: "button",
      id: "b1",
      labelKey: "restore_label",
      style: "plain",
      action: { kind: "restore" },
    };
    const purchase: PaywallNode = { type: "purchaseButton", id: "p1", labelKey: "purchase_label" };
    expect(nodeLocKey(button)).toBe("restore_label");
    expect(nodeLocKey(purchase)).toBe("purchase_label");
  });

  it("returns null for node types with no localized copy", () => {
    const stack: PaywallNode = { type: "stack", id: "s1", axis: "v", children: [] };
    const image: PaywallNode = { type: "image", id: "i1", url: { light: "" } };
    const packageList: PaywallNode = {
      type: "packageList",
      id: "pl1",
      packageIds: [],
      cellLayout: "row",
    };
    const spacer: PaywallNode = { type: "spacer", id: "sp1" };
    const divider: PaywallNode = { type: "divider", id: "d1" };
    const icon: PaywallNode = { type: "icon", id: "i1", name: "check" };
    expect(nodeLocKey(stack)).toBeNull();
    expect(nodeLocKey(image)).toBeNull();
    expect(nodeLocKey(packageList)).toBeNull();
    expect(nodeLocKey(spacer)).toBeNull();
    expect(nodeLocKey(divider)).toBeNull();
    expect(nodeLocKey(icon)).toBeNull();
  });
});

describe("NODE_TYPES", () => {
  it("lists exactly the 14 node types the add-node popover offers", () => {
    expect(NODE_TYPES).toEqual([
      "stack",
      "text",
      "image",
      "button",
      "packageList",
      "purchaseButton",
      "spacer",
      "divider",
      "icon",
      "featureList",
      "timeline",
      "socialProof",
      "stickyFooter",
      "countdown",
      "carousel",
    ]);
  });

  it("exposes carousel in the palette with a label and icon", () => {
    expect(NODE_TYPE_LABEL.carousel).toBeTruthy();
    expect(NODE_ICON.carousel).toBeTruthy();
  });

  it("lists divider and icon in the palette", () => {
    expect(NODE_TYPES).toContain("divider");
    expect(NODE_TYPES).toContain("icon");
  });

  it("gives every node type an icon and a label", () => {
    for (const t of NODE_TYPES) {
      expect(NODE_ICON[t], `no icon for ${t}`).toBeTruthy();
      expect(NODE_TYPE_LABEL[t], `no label for ${t}`).toBeTruthy();
    }
  });
});
