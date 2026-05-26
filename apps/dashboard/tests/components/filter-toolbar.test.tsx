import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import {
  FilterToolbar,
  type SubscriptionsFilterValue,
} from "../../src/components/subscriptions/filter-toolbar";

const EMPTY: SubscriptionsFilterValue = {
  search: "",
  store: [],
  productId: [],
  autoRenew: undefined,
  isTrial: undefined,
  isIntro: undefined,
  hasIssue: false,
  purchasedFrom: undefined,
  purchasedTo: undefined,
  expiresFrom: undefined,
  expiresTo: undefined,
};

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next.init({
      lng: "en",
      resources: {
        en: {
          translation: {
            subscriptions: {
              filters: {
                searchPlaceholder: "Search",
                clearSearch: "Clear search",
                store: "Store",
                storeLabels: {
                  APP_STORE: "App Store",
                  PLAY_STORE: "Play Store",
                  STRIPE: "Stripe",
                  MANUAL: "Manual",
                },
                product: "Product",
                productSearch: "Search products",
                noResults: "No matches",
                autoRenew: "Auto-renew",
                any: "Any",
                on: "On",
                off: "Off",
                more: "More filters",
                isTrial: "Trial",
                isIntro: "Intro offer",
                hasIssue: "Has issue",
                purchasedRange: "Purchased",
                expiresRange: "Expires",
                clearAll: "Clear all",
                showing: "{{visible}} of {{total}}",
              },
            },
          },
        },
      },
    });
  }
});

describe("FilterToolbar", () => {
  it("auto-renew pill cycles undefined → true → false → undefined", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <I18nextProvider i18n={i18next}>
        <FilterToolbar
          value={EMPTY}
          onChange={onChange}
          products={[]}
          visible={0}
          total={0}
        />
      </I18nextProvider>,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /auto-renew/i }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ autoRenew: true }),
    );

    rerender(
      <I18nextProvider i18n={i18next}>
        <FilterToolbar
          value={{ ...EMPTY, autoRenew: true }}
          onChange={onChange}
          products={[]}
          visible={0}
          total={0}
        />
      </I18nextProvider>,
    );
    await user.click(screen.getByRole("button", { name: /auto-renew/i }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ autoRenew: false }),
    );

    rerender(
      <I18nextProvider i18n={i18next}>
        <FilterToolbar
          value={{ ...EMPTY, autoRenew: false }}
          onChange={onChange}
          products={[]}
          visible={0}
          total={0}
        />
      </I18nextProvider>,
    );
    await user.click(screen.getByRole("button", { name: /auto-renew/i }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ autoRenew: undefined }),
    );
  });

  it("Clear all renders only when filters are set and resets the whole value", async () => {
    const onChange = vi.fn();
    const populated: SubscriptionsFilterValue = {
      ...EMPTY,
      search: "abc",
      store: ["STRIPE"],
      productId: ["p_a"],
      autoRenew: true,
      hasIssue: true,
    };
    render(
      <I18nextProvider i18n={i18next}>
        <FilterToolbar
          value={populated}
          onChange={onChange}
          products={[{ id: "p_a", label: "A" }]}
          visible={3}
          total={10}
        />
      </I18nextProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /clear all/i }));
    expect(onChange).toHaveBeenCalledWith({
      search: "",
      store: [],
      productId: [],
      autoRenew: undefined,
      isTrial: undefined,
      isIntro: undefined,
      hasIssue: false,
      purchasedFrom: undefined,
      purchasedTo: undefined,
      expiresFrom: undefined,
      expiresTo: undefined,
    });
  });
});
