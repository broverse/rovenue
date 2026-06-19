import { describe, it, expect, beforeEach } from "vitest";
import { _setNativeForTesting } from "../core/native";
import { virtualCurrencies, virtualCurrency, refreshVirtualCurrencies } from "./virtualCurrencies";

const calls: string[] = [];
const mockNative: any = {
  virtualCurrencies: async () => { calls.push("all"); return { gold: 5, gems: 2 }; },
  virtualCurrency: async (code: string) => { calls.push(`one:${code}`); return code === "gold" ? 5 : 0; },
  refreshVirtualCurrencies: async () => { calls.push("refresh"); },
};

describe("virtualCurrencies api", () => {
  beforeEach(() => { calls.length = 0; _setNativeForTesting(mockNative); });

  it("reads the balances map", async () => {
    expect(await virtualCurrencies()).toEqual({ gold: 5, gems: 2 });
    expect(calls).toContain("all");
  });
  it("reads a single currency, 0 when absent", async () => {
    expect(await virtualCurrency("gold")).toBe(5);
    expect(await virtualCurrency("silver")).toBe(0);
  });
  it("refreshes", async () => {
    await refreshVirtualCurrencies();
    expect(calls).toContain("refresh");
  });
});
