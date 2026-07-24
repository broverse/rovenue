import { describe, expect, it } from "vitest";
import { normalize, togglePlatformList } from "./visibility-tab";

// The plan called this write path "fiddly enough to get done inconsistently".
// These are the click sequences an author can actually reach.
describe("togglePlatformList", () => {
  it("turns 'no constraint' into 'the others' on the first untick", () => {
    // Writing [] here would normalize back to undefined and the box would
    // spring back ticked — the node would stay on every platform.
    expect(togglePlatformList(undefined, "ios")).toEqual(["android", "web"]);
    expect(togglePlatformList([], "web")).toEqual(["ios", "android"]);
  });

  it("removes from an existing list", () => {
    expect(togglePlatformList(["ios", "android"], "android")).toEqual(["ios"]);
  });

  it("appends when re-ticking", () => {
    expect(togglePlatformList(["ios"], "web")).toEqual(["ios", "web"]);
  });

  it("can empty the list, which normalize then reads as 'all'", () => {
    expect(togglePlatformList(["ios"], "ios")).toEqual([]);
    expect(normalize({ platform: [] })).toBeUndefined();
  });
});

describe("normalize", () => {
  it("collapses an all-defaults object to undefined", () => {
    expect(normalize({})).toBeUndefined();
    expect(normalize({ platform: [], minAppVersion: "", maxAppVersion: "  " })).toBeUndefined();
  });

  it("trims bounds and drops the blank ones", () => {
    expect(normalize({ minAppVersion: " 1.2 ", maxAppVersion: "" })).toEqual({ minAppVersion: "1.2" });
  });

  it("keeps a real platform constraint", () => {
    expect(normalize({ platform: ["ios"] })).toEqual({ platform: ["ios"] });
  });

  it("survives a full untick-then-retick round trip without leaving a stray object", () => {
    let v = normalize({ platform: togglePlatformList(undefined, "ios") });
    expect(v).toEqual({ platform: ["android", "web"] });
    v = normalize({ platform: togglePlatformList(v?.platform, "android") });
    expect(v).toEqual({ platform: ["web"] });
    v = normalize({ platform: togglePlatformList(v?.platform, "web") });
    expect(v).toBeUndefined();
  });
});
