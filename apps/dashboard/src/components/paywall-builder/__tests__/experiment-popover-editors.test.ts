import { describe, expect, it } from "vitest";
import { OVERRIDABLE_PROP_KEYS, type PaywallNode } from "@rovenue/shared/paywall";
import { detectPropEditor } from "../experiment-popover";

/**
 * One representative node per type, in the shape `newNode()` produces, so a
 * probe runs against a node the schema actually accepts. Keyed by node type
 * so a new node type without a sample fails this file by name.
 */
const SAMPLE_NODES: Record<PaywallNode["type"], PaywallNode> = {
  stack: { type: "stack", id: "n", axis: "v", children: [] },
  text: { type: "text", id: "n", key: "k", role: "body" },
  image: { type: "image", id: "n", url: { light: "" } },
  button: { type: "button", id: "n", labelKey: "k", style: "plain", action: { kind: "close" } },
  packageList: { type: "packageList", id: "n", packageIds: [], cellLayout: "column" },
  purchaseButton: { type: "purchaseButton", id: "n", labelKey: "k" },
  spacer: { type: "spacer", id: "n", size: 16 },
  divider: { type: "divider", id: "n", thickness: 1, inset: 0 },
  icon: { type: "icon", id: "n", name: "star", size: 20 },
  featureList: { type: "featureList", id: "n", rows: [{ labelKey: "k" }] },
  timeline: { type: "timeline", id: "n", rows: [{ labelKey: "k" }] },
  socialProof: { type: "socialProof", id: "n", labelKey: "k" },
  stickyFooter: { type: "stickyFooter", id: "n", children: [] },
  countdown: { type: "countdown", id: "n", durationSeconds: 600 },
  carousel: { type: "carousel", id: "n", children: [] },
  video: { type: "video", id: "n", url: { light: "" } },
  lottie: { type: "lottie", id: "n", url: { light: "" } },
  footerLinks: { type: "footerLinks", id: "n", links: [{ labelKey: "k", action: { kind: "restore" } }] },
};

describe("element-experiment prop editors", () => {
  it("resolves a usable editor for every overridable prop — no prop is a dead end", () => {
    const deadEnds: string[] = [];
    for (const [type, props] of Object.entries(OVERRIDABLE_PROP_KEYS)) {
      const node = SAMPLE_NODES[type as PaywallNode["type"]];
      for (const prop of props) {
        const editor = detectPropEditor(node, prop);
        // A `text` editor is only honest for props a typed string can express.
        // An object-valued prop landing on `text` can never validate.
        if (editor === "text" && prop === "border") deadEnds.push(`${type}.${prop}`);
      }
    }
    expect(deadEnds).toEqual([]);
  });

  it("detects the border editor for every border prop", () => {
    expect(detectPropEditor(SAMPLE_NODES.button, "border")).toBe("border");
    expect(detectPropEditor(SAMPLE_NODES.stack, "border")).toBe("border");
    expect(detectPropEditor(SAMPLE_NODES.image, "border")).toBe("border");
  });

  it("still detects number and color props, unchanged by the new probe", () => {
    expect(detectPropEditor(SAMPLE_NODES.stack, "spacing")).toBe("number");
    expect(detectPropEditor(SAMPLE_NODES.divider, "thickness")).toBe("number");
    expect(detectPropEditor(SAMPLE_NODES.text, "color")).toBe("color");
    expect(detectPropEditor(SAMPLE_NODES.stack, "background")).toBe("color");
  });

  it("leaves enum and plain-string props on the text editor", () => {
    expect(detectPropEditor(SAMPLE_NODES.button, "style")).toBe("text");
    expect(detectPropEditor(SAMPLE_NODES.text, "key")).toBe("text");
  });
});
