import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _setNativeForTesting } from "../core/native";
import { stopEventBridge } from "../core/eventBridge";
import { store } from "../store/reactiveStore";
import { makeMockNative, MockNative } from "./_mockNative";
import { configure } from "../api/configure";
import { currentUser, identify } from "../api/identity";
import { entitlement, entitlementsAll, refreshEntitlements } from "../api/entitlements";
import { creditBalance, refreshCredits, consumeCredits } from "../api/credits";
import { postAppleReceipt, postGoogleReceipt } from "../api/receipts";
import { setForeground, shutdown } from "../api/lifecycle";
import { InvalidApiKeyError, InsufficientCreditsError } from "../errors";

describe("Rovenue imperative API", () => {
  let native: MockNative;

  beforeEach(() => {
    native = makeMockNative();
    _setNativeForTesting(native);
    store.clear();
  });
  afterEach(() => {
    stopEventBridge();
    _setNativeForTesting(null);
    store.clear();
  });

  // -------- configure --------
  it("configure rejects blank api key without touching native", () => {
    expect(() => configure({ apiKey: "", baseUrl: "https://api.example.com" }))
      .toThrow(InvalidApiKeyError);
    expect(native.configure).not.toHaveBeenCalled();
  });

  it("configure rejects whitespace api key", () => {
    expect(() => configure({ apiKey: "   ", baseUrl: "https://api.example.com" }))
      .toThrow(InvalidApiKeyError);
  });

  it("configure rejects non-http baseUrl", () => {
    expect(() => configure({ apiKey: "pk_test", baseUrl: "not-a-url" }))
      .toThrow(/baseUrl/);
  });

  it("configure forwards to native + starts event bridge", () => {
    configure({ apiKey: "pk_test", baseUrl: "https://api.example.com", debug: true });
    expect(native.configure).toHaveBeenCalledWith("pk_test", "https://api.example.com", true);
    expect(native.addChangeListener).toHaveBeenCalledTimes(1);
  });

  it("configure debug defaults to false when omitted", () => {
    configure({ apiKey: "pk_test", baseUrl: "https://api.example.com" });
    expect(native.configure).toHaveBeenCalledWith("pk_test", "https://api.example.com", false);
  });

  // -------- identity --------
  it("currentUser proxies to native", async () => {
    const u = await currentUser();
    expect(u).toEqual({ anonId: "anon_test", knownUserId: null });
  });

  it("identify forwards arg + emits IDENTITY_CHANGED via mock", async () => {
    configure({ apiKey: "pk", baseUrl: "https://api.example.com" });
    await identify("user_42");
    await new Promise((r) => setTimeout(r, 0));
    expect(native.identify).toHaveBeenCalledWith("user_42");
    expect(store.get<{ knownUserId: string | null }>("user")?.knownUserId).toBe("user_42");
  });

  // -------- entitlements --------
  it("entitlement returns null when missing", async () => {
    expect(await entitlement("pro")).toBeNull();
  });

  it("entitlementsAll returns empty array by default", async () => {
    expect(await entitlementsAll()).toEqual([]);
  });

  it("refreshEntitlements triggers store update via bridge", async () => {
    configure({ apiKey: "pk", baseUrl: "https://api.example.com" });
    native.__state.entitlements.set("pro", {
      id: "pro", active: true, expiresAt: null, productId: null,
    });
    await refreshEntitlements();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.get<{ active: boolean }>("entitlement:pro")?.active).toBe(true);
  });

  // -------- credits --------
  it("creditBalance reads from native (0 default)", async () => {
    expect(await creditBalance()).toBe(0);
  });

  it("consumeCredits succeeds and returns new balance", async () => {
    native.__state.creditBalance = 10;
    expect(await consumeCredits(3, "test")).toBe(7);
  });

  it("consumeCredits throws InsufficientCreditsError with available", async () => {
    native.__state.creditBalance = 1;
    try {
      await consumeCredits(5);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InsufficientCreditsError);
      expect((e as InsufficientCreditsError).available).toBe(1);
    }
  });

  it("consumeCredits passes null description by default", async () => {
    native.__state.creditBalance = 10;
    await consumeCredits(1);
    expect(native.consumeCredits).toHaveBeenCalledWith(1, null);
  });

  it("refreshCredits triggers store update", async () => {
    configure({ apiKey: "pk", baseUrl: "https://api.example.com" });
    native.__state.creditBalance = 50;
    await refreshCredits();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.get<number>("creditBalance")).toBe(50);
  });

  // -------- receipts --------
  it("postAppleReceipt forwards args + returns ReceiptResult", async () => {
    const r = await postAppleReceipt("jws.token.here", "com.foo.pro");
    expect(r.ok).toBe(true);
    expect(native.postAppleReceipt).toHaveBeenCalledWith("jws.token.here", "com.foo.pro");
  });

  it("postGoogleReceipt forwards args + returns ReceiptResult", async () => {
    const r = await postGoogleReceipt("play.token", "com.foo.pro");
    expect(r.ok).toBe(true);
  });

  // -------- lifecycle --------
  it("setForeground forwards to native", () => {
    setForeground(true);
    expect(native.setForeground).toHaveBeenCalledWith(true);
  });

  it("shutdown stops the bridge + calls native.shutdown", () => {
    configure({ apiKey: "pk", baseUrl: "https://api.example.com" });
    shutdown();
    expect(native.shutdown).toHaveBeenCalledTimes(1);
    // After shutdown a follow-up native event must NOT mutate the store
    native.__emit("IDENTITY_CHANGED");
    expect(store.get("user")).toBeUndefined();
  });
});
