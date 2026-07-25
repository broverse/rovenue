// @vitest-environment happy-dom
//
// Same gate style as the renderer test this replaces: react-native is
// aliased to _stubReactNative and expo-modules-core to _stubExpoModules,
// so @testing-library/react drives the real wrapper and the stub records
// exactly what the native view was handed.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { __nativeViewRenders } from "../../__tests__/_stubExpoModules";
import { RovenuePaywallView } from "../RovenuePaywallView";
import { NATIVE_ERROR_ENVELOPE_PREFIX } from "../../errors";
import type { Paywall } from "../../types";

const PAYWALL: Paywall = {
  placementIdentifier: "onboarding",
  placementRevision: 3,
  paywallIdentifier: "pw_1",
  paywallName: "Onboarding",
  configFormatVersion: 2,
  remoteConfig: null,
  remoteConfigLocale: null,
  builderConfig: { formatVersion: 2 },
  offering: null,
  presentedContext: null,
  servedFromFallback: false,
};

function lastProps(): Record<string, any> {
  return __nativeViewRenders[__nativeViewRenders.length - 1]!;
}

describe("RovenuePaywallView bridges to the native view", () => {
  beforeEach(() => {
    cleanup();
    __nativeViewRenders.length = 0;
  });

  it("sends the placement identifier, not the whole paywall", () => {
    render(<RovenuePaywallView paywall={PAYWALL} />);
    expect(lastProps().placementIdentifier).toBe("onboarding");
    expect(lastProps().paywall).toBeUndefined();
  });

  it("forwards locale and colour scheme under their native names", () => {
    render(<RovenuePaywallView paywall={PAYWALL} locale="tr" colorScheme="dark" />);
    expect(lastProps().locale).toBe("tr");
    expect(lastProps().colorSchemeOverride).toBe("dark");
  });

  // The native views HIDE restore affordances when their handler is null,
  // so absence has to survive the crossing as a value the bridge can read.
  it("reports whether restore and url handlers exist", () => {
    render(<RovenuePaywallView paywall={PAYWALL} />);
    expect(lastProps().hasRestoreHandler).toBe(false);
    expect(lastProps().hasUrlHandler).toBe(false);

    render(<RovenuePaywallView paywall={PAYWALL} onRestore={() => {}} onUrl={() => {}} />);
    expect(lastProps().hasRestoreHandler).toBe(true);
    expect(lastProps().hasUrlHandler).toBe(true);
  });

  it("maps the five native events onto the callback props", () => {
    const onPurchaseCompleted = vi.fn();
    const onClose = vi.fn();
    const onRestore = vi.fn();
    const onUrl = vi.fn();
    render(
      <RovenuePaywallView
        paywall={PAYWALL}
        onPurchaseCompleted={onPurchaseCompleted}
        onClose={onClose}
        onRestore={onRestore}
        onUrl={onUrl}
      />,
    );
    const p = lastProps();
    p.onPurchaseCompleted({ nativeEvent: { result: { productId: "pro" } } });
    p.onCloseRequested({ nativeEvent: {} });
    p.onRestoreRequested({ nativeEvent: {} });
    p.onUrlRequested({ nativeEvent: { url: "https://example.com/terms" } });

    expect(onPurchaseCompleted).toHaveBeenCalledWith({ productId: "pro" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onRestore).toHaveBeenCalledOnce();
    expect(onUrl).toHaveBeenCalledWith("https://example.com/terms");
  });

  // Only code+message survive the JSI crossing, so the structured extras
  // ride inside message as a JSON envelope and are unpacked here.
  it("unpacks the native error envelope for onPurchaseFailed", () => {
    const onPurchaseFailed = vi.fn();
    render(<RovenuePaywallView paywall={PAYWALL} onPurchaseFailed={onPurchaseFailed} />);
    lastProps().onPurchaseFailed({
      nativeEvent: {
        code: "NetworkError",
        message: NATIVE_ERROR_ENVELOPE_PREFIX + JSON.stringify({ message: "offline", retryable: true }),
      },
    });
    const err = onPurchaseFailed.mock.calls[0]![0] as { message: string; isRetryable: boolean };
    expect(err.message).toBe("offline");
    // The class field is `isRetryable`; `retryable` is the ENVELOPE key.
    // Asserting the envelope key here would pass vacuously against undefined.
    expect(err.isRetryable).toBe(true);
  });

  it("does not throw when optional callbacks are omitted", () => {
    render(<RovenuePaywallView paywall={PAYWALL} />);
    const p = lastProps();
    expect(() => p.onCloseRequested({ nativeEvent: {} })).not.toThrow();
    expect(() => p.onUrlRequested({ nativeEvent: { url: "https://x" } })).not.toThrow();
  });
});
