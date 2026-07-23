import { describe, expect, it } from "vitest";
import { emptyBuilderConfig } from "@rovenue/shared/paywall";
import { PRESETS } from "./presets";
import { previewBlocks, shouldAutoOpenStart } from "./start-model";

function preset(id: "hero" | "comparison") {
  return PRESETS.find((p) => p.id === id)!.build("en");
}

describe("previewBlocks", () => {
  it("turns the hero preset into a silhouette in document order", () => {
    expect(previewBlocks(preset("hero"))).toEqual([
      { kind: "media" },
      { kind: "line", width: 0.8 },
      { kind: "line", width: 0.65 },
      { kind: "gap" },
      { kind: "cells" },
      { kind: "action" },
      { kind: "action" },
    ]);
  });

  it("turns the comparison preset into a silhouette in document order", () => {
    expect(previewBlocks(preset("comparison"))).toEqual([
      { kind: "line", width: 0.8 },
      { kind: "line", width: 0.7 },
      { kind: "cells" },
      { kind: "line", width: 0.5 },
      { kind: "action" },
      { kind: "action" },
    ]);
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
    expect(shouldAutoOpenStart(preset("hero"))).toBe(false);
  });
});
