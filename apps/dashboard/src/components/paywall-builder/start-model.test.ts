import { describe, expect, it } from "vitest";
import { emptyBuilderConfig, type BuilderConfig } from "@rovenue/shared/paywall";
import { TEMPLATES } from "./templates";
import { previewBlocks, shouldAutoOpenStart } from "./start-model";

function template(id: "hero" | "comparison") {
  return TEMPLATES.find((t) => t.id === id)!.build("en");
}

/**
 * `previewBlocks` is a pure node-type -> band mapping, so it is tested
 * against an EXPLICIT tree rather than against whatever the catalogue
 * happens to contain today. Asserting a template\'s exact silhouette made
 * this test a mirror of the catalogue: every copy edit that added or
 * removed a node broke it for no reason, and a wrong mapping could be
 * "fixed" by editing the expectation.
 */
function configWith(children: BuilderConfig["root"]["children"]): BuilderConfig {
  const config = emptyBuilderConfig("en");
  config.root.children.push(...children);
  return config;
}

describe("previewBlocks", () => {
  it("maps every node type it knows to its band, in document order", () => {
    const config = configWith([
      { type: "image", id: "img", url: { light: "" } },
      { type: "text", id: "t1", key: "t1", role: "title" },
      { type: "text", id: "t2", key: "t2", role: "subtitle" },
      { type: "spacer", id: "sp", size: 8 },
      { type: "packageList", id: "pl", packageIds: [], cellLayout: "row" },
      { type: "purchaseButton", id: "pb", labelKey: "pb" },
      { type: "button", id: "b", labelKey: "b", style: "plain", action: { kind: "restore" } },
    ]);
    expect(previewBlocks(config)).toEqual([
      { kind: "media" },
      { kind: "line", width: 0.8 },
      { kind: "line", width: 0.65 },
      { kind: "gap" },
      { kind: "cells" },
      { kind: "action" },
      { kind: "action" },
    ]);
  });

  it("gives each text role its own bar width", () => {
    const config = configWith([
      { type: "text", id: "t1", key: "t1", role: "title" },
      { type: "text", id: "t2", key: "t2", role: "body" },
      { type: "text", id: "t3", key: "t3", role: "caption" },
    ]);
    expect(previewBlocks(config)).toEqual([
      { kind: "line", width: 0.8 },
      { kind: "line", width: 0.7 },
      { kind: "line", width: 0.5 },
    ]);
  });

  it("produces a non-empty silhouette for a real catalogue template", () => {
    expect(previewBlocks(template("hero")).length).toBeGreaterThan(0);
    expect(previewBlocks(template("comparison")).length).toBeGreaterThan(0);
  });

  it("yields nothing for an empty config", () => {
    expect(previewBlocks(emptyBuilderConfig("en"))).toEqual([]);
  });

  it("skips node types it has no silhouette for", () => {
    const config = emptyBuilderConfig("en");
    config.root.children.push(
      { type: "stack", id: "nested", axis: "v", children: [] },
      { type: "spacer", id: "sp", size: 8 },
    );
    expect(previewBlocks(config)).toEqual([{ kind: "gap" }]);
  });
});

describe("shouldAutoOpenStart", () => {
  it("is true for an empty tree and false once anything is in it", () => {
    expect(shouldAutoOpenStart(emptyBuilderConfig("en"))).toBe(true);
    expect(shouldAutoOpenStart(template("hero"))).toBe(false);
  });
});
