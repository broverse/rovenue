import { describe, expect, it } from "vitest";
import type { PaywallNode } from "@rovenue/shared/paywall";
import { NODE_TYPES, nodeLocKey } from "../node-meta";

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
    expect(nodeLocKey(stack)).toBeNull();
    expect(nodeLocKey(image)).toBeNull();
    expect(nodeLocKey(packageList)).toBeNull();
    expect(nodeLocKey(spacer)).toBeNull();
  });
});

describe("NODE_TYPES", () => {
  it("lists exactly the 7 node types the add-node popover offers", () => {
    expect(NODE_TYPES).toEqual([
      "stack",
      "text",
      "image",
      "button",
      "packageList",
      "purchaseButton",
      "spacer",
    ]);
  });
});
