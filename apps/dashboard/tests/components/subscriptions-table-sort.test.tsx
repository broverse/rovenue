import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import { SubscriptionsTable } from "../../src/components/subscriptions/subscriptions-table";
import type { Subscription } from "../../src/components/subscriptions/types";

const SUB: Subscription = {
  id: "p_demo",
  user: "u_demo",
  product: "Pro",
  status: "active",
  store: "stripe",
  price: 9.99,
  billingCycle: "monthly",
  started: "2026-01-01",
  renewsIn: 10,
  renewsPct: 50,
  autoRenew: true,
  term: "Recurring",
  trialDays: 0,
  intro: false,
  cancelPolicy: "none",
  entitlements: [],
};

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next.init({
      lng: "en",
      resources: {
        en: {
          translation: {
            subscriptions: {
              table: {
                subscription: "Subscription",
                user: "User",
                product: "Product",
                status: "Status",
                store: "Store",
                price: "Price",
                term: "Started",
                lifecycle: "Lifecycle",
                nextEvent: "Renews",
                autoRenew: "Auto",
                manual: "Manual",
                intro: "Intro",
                selectAll: "Select all",
                selectRow: "Select {{id}}",
                empty: "No subscriptions",
                rowCount: "{{count}} rows",
                footerHint: "Live",
              },
            },
          },
        },
      },
    });
  }
});

describe("SubscriptionsTable — sortable headers", () => {
  it("clicking Started toggles sort direction; clicking Price switches column", async () => {
    const onSortChange = vi.fn();
    const { rerender } = render(
      <I18nextProvider i18n={i18next}>
        <SubscriptionsTable
          subscriptions={[SUB]}
          selectedIds={new Set()}
          expandedId={null}
          sort="started_desc"
          onSortChange={onSortChange}
          onToggleSelect={() => {}}
          onToggleSelectAll={() => {}}
          onToggleExpand={() => {}}
        />
      </I18nextProvider>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /sort by started/i }));
    expect(onSortChange).toHaveBeenLastCalledWith("started_asc");

    // Re-render with the new sort and verify clicking again flips back to desc.
    rerender(
      <I18nextProvider i18n={i18next}>
        <SubscriptionsTable
          subscriptions={[SUB]}
          selectedIds={new Set()}
          expandedId={null}
          sort="started_asc"
          onSortChange={onSortChange}
          onToggleSelect={() => {}}
          onToggleSelectAll={() => {}}
          onToggleExpand={() => {}}
        />
      </I18nextProvider>,
    );
    await user.click(screen.getByRole("button", { name: /sort by started/i }));
    expect(onSortChange).toHaveBeenLastCalledWith("started_desc");

    // Switching to a different column uses that column's default direction (price → price_desc).
    await user.click(screen.getByRole("button", { name: /sort by price/i }));
    expect(onSortChange).toHaveBeenLastCalledWith("price_desc");
  });
});
