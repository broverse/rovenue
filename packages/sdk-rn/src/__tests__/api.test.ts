import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _setNativeForTesting } from "../core/native";
import { stopEventBridge } from "../core/eventBridge";
import { store } from "../store/reactiveStore";
import { makeMockNative, MockNative } from "./_mockNative";
import { configure } from "../api/configure";
import { currentUser, identify, logOut } from "../api/identity";
import { entitlement, entitlementsAll, refreshEntitlements } from "../api/entitlements";
import { creditBalance, refreshCredits, consumeCredits } from "../api/credits";
import { getOfferings, purchase, restorePurchases } from "../api/purchases";
import { setForeground, shutdown } from "../api/lifecycle";
import { Rovenue } from "../index";
import { InvalidApiKeyError, InsufficientCreditsError, PurchaseCancelledError } from "../errors";

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

  it("configure rejects malformed baseUrl when provided", () => {
    expect(() => configure({ apiKey: "pk_test", baseUrl: "not-a-url" }))
      .toThrow(/baseUrl/);
  });

  it("configure omits baseUrl when not provided", () => {
    configure({ apiKey: "pk_test" });
    expect(native.configure).toHaveBeenCalledWith(
      "pk_test",
      undefined,
      false,
      undefined,
    );
  });

  it("configure forwards to native + starts event bridge", () => {
    configure({ apiKey: "pk_test", baseUrl: "https://api.example.com", debug: true });
    // 4th arg (appVersion) is undefined here — the native side will
    // auto-read Bundle.main / PackageManager when nothing is supplied.
    expect(native.configure).toHaveBeenCalledWith(
      "pk_test",
      "https://api.example.com",
      true,
      undefined,
    );
    // Event bridge attached one change listener via the emitter.
    expect(native.__state.changeListeners.length).toBe(1);
  });

  it("configure debug defaults to false when omitted", () => {
    configure({ apiKey: "pk_test", baseUrl: "https://api.example.com" });
    expect(native.configure).toHaveBeenCalledWith(
      "pk_test",
      "https://api.example.com",
      false,
      undefined,
    );
  });

  // -------- identity --------
  it("currentUser proxies to native", async () => {
    const u = await currentUser();
    expect(u).toEqual({ rovenueId: "anon_test", appUserId: null });
  });

  it("identify forwards arg + emits IDENTITY_CHANGED via mock", async () => {
    configure({ apiKey: "pk", baseUrl: "https://api.example.com" });
    await identify("user_42");
    await new Promise((r) => setTimeout(r, 0));
    expect(native.identify).toHaveBeenCalledWith("user_42");
    expect(store.get<{ appUserId: string | null }>("user")?.appUserId).toBe("user_42");
  });

  it("logOut calls native logOut", async () => {
    await logOut();
    expect(native.logOut).toHaveBeenCalledTimes(1);
  });

  it("Rovenue.logOut calls native logOut", async () => {
    await Rovenue.logOut();
    expect(native.logOut).toHaveBeenCalledTimes(1);
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

  // -------- purchases --------
  it("getOfferings maps DTO current id to all[current] offering", async () => {
    native.getOfferings = vi.fn(async () => ({
      current: "default",
      offerings: [{
        identifier: "default",
        isDefault: true,
        packages: [{
          identifier: "monthly",
          product: {
            id: "com.x.m",
            type: "subscription" as const,
            displayName: "Monthly",
            priceString: "$4.99",
            price: 4.99,
            currencyCode: "USD",
          },
        }],
      }],
    }));
    const offerings = await getOfferings();
    expect(offerings.current?.identifier).toBe("default");
    expect(offerings.all["default"].packages[0].product.id).toBe("com.x.m");
  });

  it("getOfferings sets Package.identifier from the native DTO identifier (package slot id)", async () => {
    // The native layer (Rust→Swift façade) now populates PackageDTO.identifier
    // with the package slot id (e.g. $rc_monthly), NOT the product catalog id.
    // This test asserts that getOfferings() surfaces that slot id unchanged as
    // Package.identifier, while the product's catalog id lives in Package.product.id.
    native.getOfferings = vi.fn(async () => ({
      current: "default",
      offerings: [{
        identifier: "default",
        isDefault: true,
        packages: [{
          identifier: "$rc_monthly",
          product: {
            id: "pro_monthly",
            type: "subscription" as const,
            displayName: "Pro Monthly",
            priceString: "$4.99",
            price: 4.99,
            currencyCode: "USD",
          },
        }],
      }],
    }));
    const offerings = await getOfferings();
    const pkg = offerings.all["default"].packages[0];
    expect(pkg.identifier).toBe("$rc_monthly");
    expect(pkg.product.id).toBe("pro_monthly");
  });

  it("purchase forwards product id + type to native.purchase", async () => {
    native.purchase = vi.fn(async () => ({
      entitlements: [],
      creditBalance: 0,
      productId: "com.x.m",
      storeTransactionId: "txn_abc",
    }));
    const pkg = {
      identifier: "monthly",
      product: { id: "com.x.m", type: "subscription" as const, displayName: "Monthly", priceString: "$4.99", price: 4.99, currencyCode: "USD" },
    };
    const result = await purchase(pkg);
    expect(native.purchase).toHaveBeenCalledWith("com.x.m", "subscription");
    expect(result.storeTransactionId).toBe("txn_abc");
    expect(result.productId).toBe("com.x.m");
  });

  it("purchase maps PurchaseCancelled native rejection to PurchaseCancelledError", async () => {
    native.purchase = vi.fn(async () => {
      const err: any = new Error("cancelled by user");
      err.code = "PurchaseCancelled";
      throw err;
    });
    const pkg = {
      identifier: "monthly",
      product: { id: "com.x.m", type: "subscription" as const, displayName: "Monthly", priceString: "$4.99", price: 4.99, currencyCode: "USD" },
    };
    await expect(purchase(pkg)).rejects.toBeInstanceOf(PurchaseCancelledError);
  });

  it("restorePurchases delegates to native.restorePurchases", async () => {
    native.restorePurchases = vi.fn(async () => ({
      entitlements: [],
      creditBalance: 5,
      productId: "com.x.pro",
      storeTransactionId: "txn_restore",
    }));
    const result = await restorePurchases();
    expect(native.restorePurchases).toHaveBeenCalledTimes(1);
    expect(result.creditBalance).toBe(5);
  });

  // -------- account token --------
  it("exposes getAppAccountToken on Rovenue namespace", async () => {
    const local = makeMockNative();
    local.getAppAccountToken = vi.fn(async () => "abc");
    _setNativeForTesting(local);
    expect(await Rovenue.getAppAccountToken()).toBe("abc");
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
