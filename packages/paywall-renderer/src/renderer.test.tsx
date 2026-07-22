import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import type { BuilderConfig, PackageView, PaywallNode } from "@rovenue/shared/paywall";
import { PaywallRenderer } from "./renderer";
import type { RendererOffering } from "./types";

const offering: RendererOffering = {
  identifier: "default",
  packages: [
    {
      packageIdentifier: "monthly",
      displayName: "Monthly",
      metadata: { price: "$4.99", pricePerPeriod: "$4.99/mo", period: "month" },
      storeIds: { apple: "com.rovenue.monthly" },
    },
    {
      packageIdentifier: "annual",
      displayName: "Annual",
      metadata: { price: "$39.99", pricePerPeriod: "$3.33/mo", period: "year" },
      storeIds: { apple: "com.rovenue.annual" },
    },
  ],
};

const priceView: Record<string, PackageView> = {
  monthly: { packageName: "Monthly", price: "$4.99", pricePerPeriod: "$4.99/mo", period: "month" },
  annual: { packageName: "Annual", price: "$39.99", pricePerPeriod: "$3.33/mo", period: "year" },
};

function baseConfig(overrides?: Partial<BuilderConfig>): BuilderConfig {
  return {
    formatVersion: 2,
    defaultLocale: "en",
    localizations: {
      en: {
        title: "Go Pro",
        subtitle: "Unlock everything",
        close: "Close",
        purchase: "Subscribe for {{price}}",
      },
      // tr intentionally omits every key but "title" to exercise
      // per-key locale fallback (tr -> defaultLocale "en").
      tr: {
        title: "Pro Ol",
      },
    },
    background: { light: "#ffffff", dark: "#000000" },
    root: {
      type: "stack",
      id: "root",
      axis: "v",
      spacing: 12,
      children: [
        {
          type: "text",
          id: "title",
          key: "title",
          role: "title",
          color: { light: "#111111", dark: "#eeeeee" },
        },
        {
          type: "image",
          id: "hero",
          url: { light: "https://example.com/light.png", dark: "https://example.com/dark.png" },
          alt: "Hero",
        },
        {
          type: "packageList",
          id: "packages",
          packageIds: ["monthly", "annual"],
          defaultSelected: "annual",
          cellLayout: "row",
        },
        {
          type: "purchaseButton",
          id: "purchase",
          labelKey: "purchase",
        },
        {
          type: "button",
          id: "close-btn",
          labelKey: "close",
          style: "plain",
          action: { kind: "close" },
        },
        {
          type: "spacer",
          id: "gap",
          size: 24,
        },
        {
          type: "stack",
          id: "nested",
          axis: "z",
          children: [
            { type: "text", id: "nested-text", key: "subtitle", role: "body" },
          ],
        },
      ],
    },
    ...overrides,
  };
}

function noop() {}

describe("PaywallRenderer", () => {
  it("renders every node type from the fixture config, each carrying data-rov-node", () => {
    const { container } = render(
      <PaywallRenderer
        config={baseConfig()}
        offering={offering}
        colorScheme="light"
        onPurchase={noop}
      />,
    );

    const ids = [
      "root",
      "title",
      "hero",
      "packages",
      "purchase",
      "close-btn",
      "gap",
      "nested",
      "nested-text",
    ];
    for (const id of ids) {
      const el = container.querySelector(`[data-rov-node="${id}"]`);
      expect(el, `expected an element with data-rov-node="${id}"`).not.toBeNull();
    }
  });

  it("falls back per-key from a requested locale to defaultLocale text", () => {
    const { getByText } = render(
      <PaywallRenderer
        config={baseConfig()}
        offering={offering}
        locale="tr"
        colorScheme="light"
        onPurchase={noop}
      />,
    );

    // "title" is present in tr.
    expect(getByText("Pro Ol")).toBeInTheDocument();
    // "subtitle" is missing in tr -> falls back to the en table.
    expect(getByText("Unlock everything")).toBeInTheDocument();
  });

  it("picks the dark theme color pair when colorScheme is dark", () => {
    const { container } = render(
      <PaywallRenderer
        config={baseConfig()}
        offering={offering}
        colorScheme="dark"
        onPurchase={noop}
      />,
    );

    const title = container.querySelector('[data-rov-node="title"]') as HTMLElement;
    expect(title.style.color).toBe("rgb(238, 238, 238)"); // #eeeeee
  });

  it("marks the packageList default-selected cell via aria-pressed, others false", () => {
    const { container } = render(
      <PaywallRenderer
        config={baseConfig()}
        offering={offering}
        colorScheme="light"
        onPurchase={noop}
      />,
    );

    const monthlyCell = container.querySelector('[data-rov-package="monthly"]');
    const annualCell = container.querySelector('[data-rov-package="annual"]');
    expect(monthlyCell?.getAttribute("aria-pressed")).toBe("false");
    expect(annualCell?.getAttribute("aria-pressed")).toBe("true");
  });

  it("renders a node's fallback when its type is unknown", () => {
    const config = baseConfig();
    const unknownWithFallback = {
      type: "totally-unknown",
      id: "mystery",
      fallback: { type: "text", id: "mystery-fallback", key: "title", role: "caption" },
    } as unknown as PaywallNode;
    config.root.children.push(unknownWithFallback);

    const { container } = render(
      <PaywallRenderer
        config={config}
        offering={offering}
        colorScheme="light"
        onPurchase={noop}
      />,
    );

    expect(container.querySelector('[data-rov-node="mystery-fallback"]')).not.toBeNull();
    expect(container.querySelector('[data-rov-node="mystery"]')).toBeNull();
  });

  it("renders nothing for an unknown-type node without a fallback", () => {
    const config = baseConfig();
    const unknownNoFallback = {
      type: "totally-unknown",
      id: "mystery-2",
    } as unknown as PaywallNode;
    config.root.children = [unknownNoFallback];

    const { container } = render(
      <PaywallRenderer
        config={config}
        offering={offering}
        colorScheme="light"
        onPurchase={noop}
      />,
    );

    expect(container.querySelector('[data-rov-node="mystery-2"]')).toBeNull();
    // The root stack itself still renders (empty).
    expect(container.querySelector('[data-rov-node="root"]')).not.toBeNull();
  });

  it("never throws when offering is null", () => {
    expect(() =>
      render(
        <PaywallRenderer
          config={baseConfig()}
          offering={null}
          colorScheme="light"
          onPurchase={noop}
        />,
      ),
    ).not.toThrow();
  });

  describe("selection", () => {
    it("defaults to the packageList's defaultSelected when present", () => {
      const { container } = render(
        <PaywallRenderer config={baseConfig()} offering={offering} colorScheme="light" onPurchase={noop} />,
      );
      expect(container.querySelector('[data-rov-package="annual"]')?.getAttribute("aria-pressed")).toBe(
        "true",
      );
    });

    it("falls back to the packageList's first packageId when defaultSelected is absent", () => {
      const config = baseConfig();
      const packages = config.root.children.find(
        (c): c is Extract<PaywallNode, { type: "packageList" }> => c.type === "packageList",
      )!;
      packages.defaultSelected = undefined;
      const { container } = render(
        <PaywallRenderer config={config} offering={offering} colorScheme="light" onPurchase={noop} />,
      );
      expect(container.querySelector('[data-rov-package="monthly"]')?.getAttribute("aria-pressed")).toBe(
        "true",
      );
    });

    it("falls back to the offering's first package when there is no packageList at all", () => {
      const config = baseConfig({
        root: {
          type: "stack",
          id: "root",
          axis: "v",
          children: [{ type: "purchaseButton", id: "purchase", labelKey: "purchase" }],
        },
      });
      const { container } = render(
        <PaywallRenderer config={config} offering={offering} colorScheme="light" onPurchase={noop} />,
      );
      const button = container.querySelector('[data-rov-node="purchase"]') as HTMLButtonElement;
      // selected via offering.packages[0] ("monthly") -> purchaseButton enabled.
      expect(button.disabled).toBe(false);
    });

    it("resolves to null when there is no packageList and no offering", () => {
      const config = baseConfig({
        root: {
          type: "stack",
          id: "root",
          axis: "v",
          children: [{ type: "purchaseButton", id: "purchase", labelKey: "purchase" }],
        },
      });
      const { container } = render(
        <PaywallRenderer config={config} offering={null} colorScheme="light" onPurchase={noop} />,
      );
      const button = container.querySelector('[data-rov-node="purchase"]') as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });

    it("clicking a packageList cell switches selection and updates aria-pressed", () => {
      const { container } = render(
        <PaywallRenderer config={baseConfig()} offering={offering} colorScheme="light" onPurchase={noop} />,
      );
      const monthlyCell = container.querySelector('[data-rov-package="monthly"]') as HTMLButtonElement;
      const annualCell = container.querySelector('[data-rov-package="annual"]') as HTMLButtonElement;

      fireEvent.click(monthlyCell);

      expect(monthlyCell.getAttribute("aria-pressed")).toBe("true");
      expect(annualCell.getAttribute("aria-pressed")).toBe("false");
    });
  });

  describe("purchase", () => {
    it("fires onPurchase with the selected package identifier", () => {
      const onPurchase = vi.fn();
      const { container } = render(
        <PaywallRenderer config={baseConfig()} offering={offering} colorScheme="light" onPurchase={onPurchase} />,
      );
      const purchaseButton = container.querySelector('[data-rov-node="purchase"]') as HTMLButtonElement;
      fireEvent.click(purchaseButton);
      expect(onPurchase).toHaveBeenCalledWith("annual");
    });

    it("fires onPurchase with the newly selected package identifier after a click", () => {
      const onPurchase = vi.fn();
      const { container } = render(
        <PaywallRenderer config={baseConfig()} offering={offering} colorScheme="light" onPurchase={onPurchase} />,
      );
      fireEvent.click(container.querySelector('[data-rov-package="monthly"]') as HTMLButtonElement);
      fireEvent.click(container.querySelector('[data-rov-node="purchase"]') as HTMLButtonElement);
      expect(onPurchase).toHaveBeenCalledWith("monthly");
    });

    it("disables purchaseButton and never fires onPurchase when there is no selectable package", () => {
      const onPurchase = vi.fn();
      const config = baseConfig({
        root: {
          type: "stack",
          id: "root",
          axis: "v",
          children: [{ type: "purchaseButton", id: "purchase", labelKey: "purchase" }],
        },
      });
      const { container } = render(
        <PaywallRenderer config={config} offering={null} colorScheme="light" onPurchase={onPurchase} />,
      );
      const purchaseButton = container.querySelector('[data-rov-node="purchase"]') as HTMLButtonElement;
      expect(purchaseButton.disabled).toBe(true);
      fireEvent.click(purchaseButton);
      expect(onPurchase).not.toHaveBeenCalled();
    });
  });

  describe("restore action", () => {
    function restoreConfig(): BuilderConfig {
      return baseConfig({
        localizations: {
          en: { title: "Go Pro", subtitle: "Unlock everything", close: "Close", purchase: "Subscribe for {{price}}", restore: "Restore" },
        },
        root: {
          type: "stack",
          id: "root",
          axis: "v",
          children: [
            { type: "button", id: "restore-btn", labelKey: "restore", style: "plain", action: { kind: "restore" } },
          ],
        },
      });
    }

    it("hides the restore button entirely when onRestore is absent", () => {
      const { container } = render(
        <PaywallRenderer config={restoreConfig()} offering={offering} colorScheme="light" onPurchase={noop} />,
      );
      expect(container.querySelector('[data-rov-node="restore-btn"]')).toBeNull();
    });

    it("renders and wires the restore button when onRestore is present", () => {
      const onRestore = vi.fn();
      const { container } = render(
        <PaywallRenderer
          config={restoreConfig()}
          offering={offering}
          colorScheme="light"
          onPurchase={noop}
          onRestore={onRestore}
        />,
      );
      const restoreBtn = container.querySelector('[data-rov-node="restore-btn"]') as HTMLButtonElement;
      expect(restoreBtn).not.toBeNull();
      fireEvent.click(restoreBtn);
      expect(onRestore).toHaveBeenCalledTimes(1);
    });
  });

  describe("variable resolution", () => {
    it("swaps purchaseButton variable text when selection changes, without touching other cells", () => {
      const { container, getByText } = render(
        <PaywallRenderer
          config={baseConfig()}
          offering={offering}
          priceView={priceView}
          colorScheme="light"
          onPurchase={noop}
        />,
      );

      // default selection is "annual" -> purchase button shows the annual price.
      expect(getByText("Subscribe for $39.99")).toBeInTheDocument();

      fireEvent.click(container.querySelector('[data-rov-package="monthly"]') as HTMLButtonElement);

      // selection changed -> purchase button text re-resolves against monthly.
      expect(getByText("Subscribe for $4.99")).toBeInTheDocument();

      // cell-scoped: each packageList cell always shows its OWN package's price,
      // never the globally selected one.
      const annualCell = container.querySelector('[data-rov-package="annual"]') as HTMLElement;
      expect(annualCell.textContent).toContain("$39.99");
      const monthlyCell = container.querySelector('[data-rov-package="monthly"]') as HTMLElement;
      expect(monthlyCell.textContent).toContain("$4.99");
    });
  });
});
