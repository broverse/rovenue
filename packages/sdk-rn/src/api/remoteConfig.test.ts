import { describe, expect, it, beforeEach } from "vitest";
import {
  getFlag,
  getRemoteConfig,
  getExperiment,
  getExperiments,
  parseRemoteConfig,
  refreshRemoteConfig,
} from "./remoteConfig";
import { _setNativeForTesting } from "../core/native";
import { makeMockNative } from "../__tests__/_mockNative";

function seed() {
  const mock = makeMockNative();
  mock.__state.remoteConfig.flags = {
    new_paywall: true,
    max_items: 5,
    welcome_text: "hi",
    theme: { color: "blue" },
  };
  mock.__state.remoteConfig.experiments = {
    checkout_test: {
      experimentId: "exp_1",
      key: "checkout_test",
      variantId: "var_b",
      variantName: "Treatment",
      valueJson: JSON.stringify({ layout: "compact" }),
    },
  };
  _setNativeForTesting(mock);
  return mock;
}

describe("remoteConfig api", () => {
  beforeEach(() => {
    _setNativeForTesting(null);
  });

  it("getFlag selects the native getter by fallback type and parses objects", async () => {
    seed();
    expect(await getFlag("new_paywall", false)).toBe(true);
    expect(await getFlag("max_items", 0)).toBe(5);
    expect(await getFlag("welcome_text", "x")).toBe("hi");
    expect(await getFlag("theme", {} as { color: string })).toEqual({ color: "blue" });
    // unknown / wrong-type keys fall back
    expect(await getFlag("missing", true)).toBe(true);
  });

  it("getRemoteConfig returns the parsed bundle with experiment values", async () => {
    seed();
    const config = await getRemoteConfig();
    expect(config.flags.new_paywall).toBe(true);
    expect(config.experiments.checkout_test.variantName).toBe("Treatment");
    expect(config.experiments.checkout_test.value).toEqual({ layout: "compact" });
  });

  it("getExperiment / getExperiments parse valueJson", async () => {
    seed();
    const exp = await getExperiment("checkout_test");
    expect(exp?.experimentId).toBe("exp_1");
    expect(exp?.value).toEqual({ layout: "compact" });
    expect(await getExperiment("nope")).toBeNull();
    expect(await getExperiments()).toHaveLength(1);
  });

  it("refreshRemoteConfig forwards to native", async () => {
    const mock = seed();
    await refreshRemoteConfig();
    expect(mock.refreshRemoteConfig).toHaveBeenCalled();
  });

  it("parseRemoteConfig tolerates malformed payloads", () => {
    expect(parseRemoteConfig("not json")).toEqual({ flags: {}, experiments: {} });
    expect(parseRemoteConfig('{"flags":{"a":1}}').flags.a).toBe(1);
  });
});
