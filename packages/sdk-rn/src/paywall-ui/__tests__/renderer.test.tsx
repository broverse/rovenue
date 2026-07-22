// @vitest-environment happy-dom
//
// Behavior tests for the RN builder-paywall renderer. react-native is
// aliased to _stubReactNative (View/Text/Pressable/Image render DOM
// equivalents; testID → data-testid, onPress → onClick), so
// @testing-library/react drives real interaction against the real
// renderer logic — the same gate style the web renderer uses.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Offering, Paywall, StoreProduct } from "../../types";

const purchaseMock = vi.hoisted(() => vi.fn(async () => ({ ok: true }) as never));
const logShownMock = vi.hoisted(() => vi.fn());
vi.mock("../../api/purchases", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  purchase: purchaseMock,
}));
vi.mock("../../api/paywalls", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logPaywallShown: logShownMock,
}));

import { RovenuePaywallView } from "../RovenuePaywallView";

function product(overrides: Partial<StoreProduct> = {}): StoreProduct {
  return {
    id: "com.x.pro.monthly",
    type: "subscription",
    productCategory: "subscription",
    displayName: "Pro Monthly",
    description: null,
    priceString: "$9.99",
    price: 9.99,
    currencyCode: "USD",
    subscriptionPeriod: { value: 1, unit: "month", iso8601: "P1M" },
    subscriptionGroupIdentifier: null,
    isFamilyShareable: false,
    introPrice: null,
    discounts: [],
    isEligibleForIntroOffer: null,
    subscriptionOptions: null,
    defaultOption: null,
    pricePerWeek: null,
    pricePerMonth: null,
    pricePerYear: null,
    pricePerWeekString: null,
    pricePerMonthString: null,
    pricePerYearString: null,
    rawStoreProduct: null,
    ...overrides,
  } as StoreProduct;
}

function offering(): Offering {
  return {
    identifier: "default",
    isDefault: true,
    packages: [
      { identifier: "$rov_monthly", packageType: "monthly", product: product() },
      {
        identifier: "$rov_annual",
        packageType: "annual",
        product: product({
          id: "com.x.pro.annual",
          displayName: "Pro Annual",
          priceString: "$39.99",
          subscriptionPeriod: { value: 1, unit: "year", iso8601: "P1Y" },
        }),
      },
    ],
  } as Offering;
}

const builderConfig = {
  formatVersion: 2,
  defaultLocale: "en",
  localizations: {
    en: { title: "Go Pro", cta: "Continue — {{price}}", restore: "Restore", close: "Not now" },
    tr: { title: "Pro'ya geç" },
  },
  root: {
    type: "stack",
    id: "root",
    axis: "v",
    children: [
      { type: "text", id: "t1", key: "title", role: "title" },
      { type: "packageList", id: "pl", packageIds: [], cellLayout: "column" },
      { type: "purchaseButton", id: "pb", labelKey: "cta" },
      {
        type: "button",
        id: "b_restore",
        labelKey: "restore",
        style: "plain",
        action: { kind: "restore" },
      },
      {
        type: "unknownWidget",
        id: "uw",
        fallback: { type: "text", id: "uw_fb", key: "close", role: "caption" },
      },
    ],
  },
};

function paywall(overrides: Partial<Paywall> = {}): Paywall {
  return {
    placementIdentifier: "onboarding",
    placementRevision: 1,
    paywallIdentifier: "pw_1",
    paywallName: "Go Pro",
    configFormatVersion: 2,
    remoteConfig: null,
    remoteConfigLocale: null,
    builderConfig,
    offering: offering(),
    presentedContext: {
      placementId: "onboarding",
      paywallId: "pw_db_1",
      variantId: null,
      experimentKey: null,
      revision: 1,
    },
    ...overrides,
  } as Paywall;
}

beforeEach(() => {
  cleanup();
  purchaseMock.mockClear();
  logShownMock.mockClear();
});

describe("RovenuePaywallView", () => {
  it("renders the tree with testIDs, resolves locale text, and defaults selection to the first package", () => {
    render(<RovenuePaywallView paywall={paywall()} locale="tr" onRestore={() => {}} />);
    expect(screen.getByTestId("rov-node-t1").textContent).toBe("Pro'ya geç"); // tr hit
    // Empty packageIds = all offering packages.
    expect(screen.getByTestId("rov-cell-$rov_monthly")).toBeTruthy();
    expect(screen.getByTestId("rov-cell-$rov_annual")).toBeTruthy();
    expect(
      screen.getByTestId("rov-cell-$rov_monthly").getAttribute("aria-selected"),
    ).toBe("true");
    // Variables resolve against the SELECTED package.
    expect(screen.getByTestId("rov-node-pb").textContent).toContain("$9.99");
    // Unknown node renders its fallback ("Not now" via en fallback).
    expect(screen.getByTestId("rov-node-uw_fb").textContent).toBe("Not now");
  });

  it("click switches selection and re-resolves variable text; purchase fires with the selected package", async () => {
    render(<RovenuePaywallView paywall={paywall()} />);
    fireEvent.click(screen.getByTestId("rov-cell-$rov_annual"));
    expect(
      screen.getByTestId("rov-cell-$rov_annual").getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByTestId("rov-node-pb").textContent).toContain("$39.99");

    fireEvent.click(screen.getByTestId("rov-node-pb"));
    expect(purchaseMock).toHaveBeenCalledTimes(1);
    expect(purchaseMock.mock.calls[0]![0]).toMatchObject({ identifier: "$rov_annual" });
  });

  it("disables purchase when the offering has no packages", () => {
    const p = paywall({ offering: { identifier: "d", isDefault: true, packages: [] } as Offering });
    render(<RovenuePaywallView paywall={p} />);
    fireEvent.click(screen.getByTestId("rov-node-pb"));
    expect(purchaseMock).not.toHaveBeenCalled();
  });

  it("hides restore buttons when no onRestore handler is supplied", () => {
    render(<RovenuePaywallView paywall={paywall()} />);
    expect(screen.queryByTestId("rov-node-b_restore")).toBeNull();
  });

  it("renders nothing for a paywall without builderConfig", () => {
    const { container } = render(
      <RovenuePaywallView paywall={paywall({ builderConfig: null })} />,
    );
    expect(container.firstChild).toBeNull();
    expect(logShownMock).not.toHaveBeenCalled();
  });

  it("auto-logs once per content, and re-logs + resets selection when the paywall content swaps", () => {
    const { rerender } = render(<RovenuePaywallView paywall={paywall()} />);
    expect(logShownMock).toHaveBeenCalledTimes(1);

    // Same content re-render → no re-log.
    rerender(<RovenuePaywallView paywall={paywall()} />);
    expect(logShownMock).toHaveBeenCalledTimes(1);

    // Select annual, then swap in different content: selection re-derives,
    // impression logs again (Swift paywallStateKey / Kotlin bind parity).
    fireEvent.click(screen.getByTestId("rov-cell-$rov_annual"));
    const swapped = paywall({
      paywallIdentifier: "pw_2",
      builderConfig: { ...builderConfig, localizations: { en: { ...builderConfig.localizations.en, title: "Go Pro 2" } } },
    });
    rerender(<RovenuePaywallView paywall={swapped} />);
    expect(logShownMock).toHaveBeenCalledTimes(2);
    expect(
      screen.getByTestId("rov-cell-$rov_monthly").getAttribute("aria-selected"),
    ).toBe("true");
  });
});
