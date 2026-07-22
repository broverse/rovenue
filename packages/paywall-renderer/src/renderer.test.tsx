import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import type { BuilderConfig, OverrideCondition, PackageView, PaywallNode } from "@rovenue/shared/paywall";
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

  describe("packageList rendering", () => {
    it("renders all offering packages when packageIds is empty", () => {
      const config = baseConfig();
      const packages = config.root.children.find(
        (c): c is Extract<PaywallNode, { type: "packageList" }> => c.type === "packageList",
      )!;
      packages.packageIds = [];
      const { container } = render(
        <PaywallRenderer config={config} offering={offering} colorScheme="light" onPurchase={noop} />,
      );
      expect(container.querySelector('[data-rov-package="monthly"]')).not.toBeNull();
      expect(container.querySelector('[data-rov-package="annual"]')).not.toBeNull();
    });

    it("renders only specified packageIds when packageIds is non-empty", () => {
      const config = baseConfig();
      const packages = config.root.children.find(
        (c): c is Extract<PaywallNode, { type: "packageList" }> => c.type === "packageList",
      )!;
      packages.packageIds = ["monthly"];
      const { container } = render(
        <PaywallRenderer config={config} offering={offering} colorScheme="light" onPurchase={noop} />,
      );
      expect(container.querySelector('[data-rov-package="monthly"]')).not.toBeNull();
      expect(container.querySelector('[data-rov-package="annual"]')).toBeNull();
    });
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

    it("falls back to the offering's first package when packageIds is empty", () => {
      const config = baseConfig();
      const packages = config.root.children.find(
        (c): c is Extract<PaywallNode, { type: "packageList" }> => c.type === "packageList",
      )!;
      packages.packageIds = [];
      packages.defaultSelected = undefined;
      const { container } = render(
        <PaywallRenderer config={config} offering={offering} colorScheme="light" onPurchase={noop} />,
      );
      // Selection should be "monthly" (offering.packages[0])
      expect(container.querySelector('[data-rov-package="monthly"]')?.getAttribute("aria-pressed")).toBe(
        "true",
      );
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

    it("fires onPurchase with the first offering package when packageIds is empty", () => {
      const onPurchase = vi.fn();
      const config = baseConfig();
      const packages = config.root.children.find(
        (c): c is Extract<PaywallNode, { type: "packageList" }> => c.type === "packageList",
      )!;
      packages.packageIds = [];
      packages.defaultSelected = undefined;
      const { container } = render(
        <PaywallRenderer config={config} offering={offering} colorScheme="light" onPurchase={onPurchase} />,
      );
      const purchaseButton = container.querySelector('[data-rov-node="purchase"]') as HTMLButtonElement;
      fireEvent.click(purchaseButton);
      // Should fire with the first offering package ("monthly")
      expect(onPurchase).toHaveBeenCalledWith("monthly");
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

    it("resolves new optional priceView fields, leaving an absent field's placeholder verbatim", () => {
      const config = baseConfig({
        localizations: {
          en: {
            title: "Go Pro",
            subtitle: "Unlock everything",
            close: "Close",
            purchase: "Subscribe for {{price}}",
            promo: "{{pricePerMonth}} monthly, then {{introPrice}} intro, save {{relativeDiscount}}",
          },
        },
        root: {
          type: "stack",
          id: "root",
          axis: "v",
          children: [
            { type: "text", id: "promo", key: "promo", role: "body" },
            {
              type: "packageList",
              id: "packages",
              packageIds: ["monthly", "annual"],
              defaultSelected: "annual",
              cellLayout: "row",
            },
            { type: "purchaseButton", id: "purchase", labelKey: "purchase" },
          ],
        },
      });
      const richPriceView: Record<string, PackageView> = {
        annual: {
          packageName: "Annual",
          price: "$39.99",
          pricePerPeriod: "$3.33/mo",
          period: "year",
          pricePerMonth: "$3.33",
          relativeDiscount: "33%",
          // introPrice intentionally absent -> its placeholder stays verbatim.
        },
      };
      const { getByText } = render(
        <PaywallRenderer
          config={config}
          offering={offering}
          priceView={richPriceView}
          colorScheme="light"
          onPurchase={noop}
        />,
      );
      expect(getByText("$3.33 monthly, then {{introPrice}} intro, save 33%")).toBeInTheDocument();
    });
  });

  describe("overrides + eligibility", () => {
    function eligibilityConfig(): BuilderConfig {
      return baseConfig({
        localizations: {
          en: {
            title: "Go Pro",
            title_eligible: "Try Free Then Go Pro",
            subtitle: "Unlock everything",
            close: "Close",
            purchase: "Subscribe for {{price}}",
          },
        },
        root: {
          type: "stack",
          id: "root",
          axis: "v",
          children: [
            {
              type: "text",
              id: "title",
              key: "title",
              role: "title",
              overrides: [{ when: { kind: "introEligible" }, props: { key: "title_eligible" } }],
            },
            {
              type: "packageList",
              id: "packages",
              packageIds: ["monthly", "annual"],
              defaultSelected: "annual",
              cellLayout: "row",
            },
            { type: "purchaseButton", id: "purchase", labelKey: "purchase" },
          ],
        },
      });
    }

    it("applies an introEligible override's swapped text key when the selected package is eligible", () => {
      const { getByText, queryByText } = render(
        <PaywallRenderer
          config={eligibilityConfig()}
          offering={offering}
          eligibility={{ annual: true }}
          colorScheme="light"
          onPurchase={noop}
        />,
      );
      expect(getByText("Try Free Then Go Pro")).toBeInTheDocument();
      expect(queryByText("Go Pro")).toBeNull();
    });

    it("does not apply the override when the selected package is not eligible", () => {
      const { getByText } = render(
        <PaywallRenderer
          config={eligibilityConfig()}
          offering={offering}
          eligibility={{ monthly: true }}
          colorScheme="light"
          onPurchase={noop}
        />,
      );
      // "annual" is selected (defaultSelected) but eligibility only covers "monthly".
      expect(getByText("Go Pro")).toBeInTheDocument();
    });

    it("treats eligibility as false for everyone when the prop is absent", () => {
      const { getByText } = render(
        <PaywallRenderer
          config={eligibilityConfig()}
          offering={offering}
          colorScheme="light"
          onPurchase={noop}
        />,
      );
      expect(getByText("Go Pro")).toBeInTheDocument();
    });

    it("re-evaluates introEligible against the newly selected package after a click", () => {
      const { getByText, container } = render(
        <PaywallRenderer
          config={eligibilityConfig()}
          offering={offering}
          eligibility={{ monthly: true }}
          colorScheme="light"
          onPurchase={noop}
        />,
      );
      expect(getByText("Go Pro")).toBeInTheDocument();
      fireEvent.click(container.querySelector('[data-rov-package="monthly"]') as HTMLButtonElement);
      expect(getByText("Try Free Then Go Pro")).toBeInTheDocument();
    });

    it("skips an override with an unknown when.kind defensively", () => {
      const config = eligibilityConfig();
      const titleNode = config.root.children.find((c) => c.type === "text")!;
      titleNode.overrides = [
        {
          when: { kind: "somethingFuture" } as unknown as OverrideCondition,
          props: { key: "title_eligible" },
        },
      ];
      const { getByText } = render(
        <PaywallRenderer
          config={config}
          offering={offering}
          eligibility={{ annual: true }}
          colorScheme="light"
          onPurchase={noop}
        />,
      );
      // an unknown condition kind is never active, regardless of eligibility.
      expect(getByText("Go Pro")).toBeInTheDocument();
    });

    it("never activates a selected-condition override on a node outside any cellTemplate subtree", () => {
      const config = eligibilityConfig();
      const purchaseNode = config.root.children.find(
        (c): c is Extract<PaywallNode, { type: "purchaseButton" }> => c.type === "purchaseButton",
      )!;
      purchaseNode.overrides = [{ when: { kind: "selected" }, props: { labelKey: "close" } }];
      const { getByText } = render(
        <PaywallRenderer
          config={config}
          offering={offering}
          priceView={priceView}
          colorScheme="light"
          onPurchase={noop}
        />,
      );
      // base labelKey "purchase" resolves normally; "selected" never activates outside cellTemplate.
      expect(getByText("Subscribe for $39.99")).toBeInTheDocument();
    });
  });

  describe("cellTemplate", () => {
    function cellTemplateConfig(): BuilderConfig {
      return {
        formatVersion: 2,
        defaultLocale: "en",
        localizations: {
          en: { cell_name: "{{packageName}}", cell_price: "{{price}}" },
        },
        root: {
          type: "stack",
          id: "root",
          axis: "v",
          children: [
            {
              type: "packageList",
              id: "packages",
              packageIds: ["monthly", "annual"],
              defaultSelected: "annual",
              cellLayout: "row",
              cellTemplate: {
                type: "stack",
                id: "cell_root",
                axis: "v",
                overrides: [
                  { when: { kind: "selected" }, props: { background: { light: "#EEF2FF" } } },
                ],
                children: [
                  { type: "text", id: "cell_name", key: "cell_name", role: "body" },
                  { type: "text", id: "cell_price", key: "cell_price", role: "caption" },
                ],
              },
            },
          ],
        },
      };
    }

    it("renders the cellTemplate subtree once per effective package, with cell-scoped variables", () => {
      const { container } = render(
        <PaywallRenderer
          config={cellTemplateConfig()}
          offering={offering}
          priceView={priceView}
          colorScheme="light"
          onPurchase={noop}
        />,
      );
      const monthlyCell = container.querySelector('[data-rov-package="monthly"]') as HTMLElement;
      const annualCell = container.querySelector('[data-rov-package="annual"]') as HTMLElement;
      expect(monthlyCell.textContent).toContain("Monthly");
      expect(monthlyCell.textContent).toContain("$4.99");
      expect(annualCell.textContent).toContain("Annual");
      expect(annualCell.textContent).toContain("$39.99");
    });

    it("keeps aria-pressed/selection/click behavior unchanged for cellTemplate cells", () => {
      const { container } = render(
        <PaywallRenderer
          config={cellTemplateConfig()}
          offering={offering}
          priceView={priceView}
          colorScheme="light"
          onPurchase={noop}
        />,
      );
      const monthlyCell = container.querySelector('[data-rov-package="monthly"]') as HTMLButtonElement;
      const annualCell = container.querySelector('[data-rov-package="annual"]') as HTMLButtonElement;
      expect(annualCell.getAttribute("aria-pressed")).toBe("true");
      expect(monthlyCell.getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(monthlyCell);
      expect(monthlyCell.getAttribute("aria-pressed")).toBe("true");
      expect(annualCell.getAttribute("aria-pressed")).toBe("false");
    });

    it("applies a selected-condition override only to the currently-selected cell's subtree", () => {
      const { container } = render(
        <PaywallRenderer
          config={cellTemplateConfig()}
          offering={offering}
          priceView={priceView}
          colorScheme="light"
          onPurchase={noop}
        />,
      );
      const monthlyCellRoot = container.querySelector(
        '[data-rov-package="monthly"] [data-rov-node="cell_root"]',
      ) as HTMLElement;
      const annualCellRoot = container.querySelector(
        '[data-rov-package="annual"] [data-rov-node="cell_root"]',
      ) as HTMLElement;
      // "annual" is defaultSelected -> its cell_root subtree gets the override background.
      expect(annualCellRoot.style.backgroundColor).toBe("rgb(238, 242, 255)"); // #EEF2FF
      expect(monthlyCellRoot.style.backgroundColor).toBe("");
    });

    it("applies overrides in array order (later wins) when both introEligible and selected are active", () => {
      const config: BuilderConfig = {
        formatVersion: 2,
        defaultLocale: "en",
        localizations: { en: { cell_name: "Plan" } },
        root: {
          type: "stack",
          id: "root",
          axis: "v",
          children: [
            {
              type: "packageList",
              id: "packages",
              packageIds: ["monthly", "annual"],
              defaultSelected: "annual",
              cellLayout: "row",
              cellTemplate: {
                type: "text",
                id: "cell_name",
                key: "cell_name",
                role: "body",
                overrides: [
                  { when: { kind: "introEligible" }, props: { align: "start" } },
                  { when: { kind: "selected" }, props: { align: "end" } },
                ],
              },
            },
          ],
        },
      };
      const { container } = render(
        <PaywallRenderer
          config={config}
          offering={offering}
          eligibility={{ annual: true }}
          colorScheme="light"
          onPurchase={noop}
        />,
      );
      const annualText = container.querySelector(
        '[data-rov-package="annual"] [data-rov-node="cell_name"]',
      ) as HTMLElement;
      const monthlyText = container.querySelector(
        '[data-rov-package="monthly"] [data-rov-node="cell_name"]',
      ) as HTMLElement;
      // annual: introEligible AND selected both active -> later ("selected" -> "end"/"right") wins.
      expect(annualText.style.textAlign).toBe("right");
      // monthly: neither active (not eligible, not selected) -> no override applied.
      expect(monthlyText.style.textAlign).toBe("");
    });

    it("without cellTemplate, renders the built-in cell exactly as before (backward-compat)", () => {
      const { container } = render(
        <PaywallRenderer
          config={baseConfig()}
          offering={offering}
          priceView={priceView}
          colorScheme="light"
          onPurchase={noop}
        />,
      );
      const monthlyCell = container.querySelector('[data-rov-package="monthly"]') as HTMLElement;
      expect(monthlyCell.outerHTML).toMatchInlineSnapshot(`"<button type="button" data-rov-package="monthly" aria-pressed="false" style="cursor: pointer; display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border-radius: 8px; border: 1px solid rgb(204, 204, 204); background: transparent; text-align: left;"><span style="font-size: 14px; font-weight: 600; color: rgb(15, 23, 42);">Monthly</span><span style="font-size: 12px; color: rgb(15, 23, 42);">$4.99</span></button>"`);
    });
  });

  describe("default text ink (self-containment)", () => {
    // Regression guard for a browser-smoke finding: with no `color` on a
    // text node the renderer used to emit no colour at all, so text
    // inherited the HOST page's colour — inside a dark-themed host (the
    // dashboard's builder canvas) that meant white-on-white in the light
    // preview. The renderer paints its own backgrounds, so it must paint
    // its own ink too.
    function uncolouredTitleConfig(): BuilderConfig {
      return {
        formatVersion: 2,
        defaultLocale: "en",
        localizations: { en: { t: "Go Pro" } },
        root: {
          type: "stack",
          id: "root",
          axis: "v",
          children: [{ type: "text", id: "t1", key: "t", role: "title" }],
        },
      };
    }

    it("inks uncoloured text dark in the light scheme", () => {
      const { container } = render(
        <PaywallRenderer
          config={uncolouredTitleConfig()}
          offering={null}
          colorScheme="light"
          onPurchase={noop}
        />,
      );
      const title = container.querySelector('[data-rov-node="t1"]') as HTMLElement;
      expect(title.style.color).toBe("rgb(15, 23, 42)");
    });

    it("inks uncoloured text light in the dark scheme", () => {
      const { container } = render(
        <PaywallRenderer
          config={uncolouredTitleConfig()}
          offering={null}
          colorScheme="dark"
          onPurchase={noop}
        />,
      );
      const title = container.querySelector('[data-rov-node="t1"]') as HTMLElement;
      expect(title.style.color).toBe("rgb(248, 250, 252)");
    });

    it("an explicit colour still wins over the default ink", () => {
      const config = uncolouredTitleConfig();
      (config.root.children[0] as { color?: unknown }).color = {
        light: "#FF0000",
        dark: "#00FF00",
      };
      const { container } = render(
        <PaywallRenderer
          config={config}
          offering={null}
          colorScheme="dark"
          onPurchase={noop}
        />,
      );
      const title = container.querySelector('[data-rov-node="t1"]') as HTMLElement;
      expect(title.style.color).toBe("rgb(0, 255, 0)");
    });
  });

  describe("built-in cell selection affordance", () => {
    // Regression guard for a browser-smoke finding: the selected cell's
    // border was a hardcoded near-black, so on a dark background it vanished
    // while the lighter unselected borders stood out — selection read
    // inverted. Renderer-owned chrome must follow the scheme like everything
    // else the renderer paints.
    function cellsConfig(): BuilderConfig {
      return {
        formatVersion: 2,
        defaultLocale: "en",
        localizations: { en: { buy: "Buy" } },
        root: {
          type: "stack",
          id: "root",
          axis: "v",
          children: [
            { type: "packageList", id: "pl", packageIds: [], cellLayout: "column" },
            { type: "purchaseButton", id: "pb", labelKey: "buy" },
          ],
        },
      };
    }

    it("keeps the selected border brighter than the unselected one in dark mode", () => {
      const { container } = render(
        <PaywallRenderer
          config={cellsConfig()}
          offering={offering}
          priceView={priceView}
          colorScheme="dark"
          onPurchase={noop}
        />,
      );
      const selected = container.querySelector('[aria-pressed="true"]') as HTMLElement;
      const unselected = container.querySelector('[aria-pressed="false"]') as HTMLElement;
      expect(selected.style.border).toBe("2px solid rgb(248, 250, 252)");
      expect(unselected.style.border).toBe("1px solid rgb(63, 63, 70)");
    });

    it("leaves the light-mode borders as they were", () => {
      const { container } = render(
        <PaywallRenderer
          config={cellsConfig()}
          offering={offering}
          priceView={priceView}
          colorScheme="light"
          onPurchase={noop}
        />,
      );
      const selected = container.querySelector('[aria-pressed="true"]') as HTMLElement;
      const unselected = container.querySelector('[aria-pressed="false"]') as HTMLElement;
      expect(selected.style.border).toBe("2px solid rgb(17, 17, 17)");
      expect(unselected.style.border).toBe("1px solid rgb(204, 204, 204)");
    });
  });
});
