import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import {
  COUNTDOWN_FIRST_SHOWN_AT_KEY_PREFIX,
  COUNTDOWN_TICK_MS,
  iconRegistry,
  SOCIAL_PROOF_MAX_RATING,
} from "@rovenue/shared/paywall";
import type { BuilderConfig, CarouselNode, OverrideCondition, PackageView, PaywallNode } from "@rovenue/shared/paywall";
import { resolvePersistedFirstShownAt } from "./first-shown";
import { PaywallRenderer } from "./renderer";
import { CAROUSEL_DOT_ACTIVE_OPACITY, CAROUSEL_DOT_INACTIVE_OPACITY } from "./styles";
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

/** Wrap a single node as the whole tree, for tests that only care about one node type. */
function cfg(node: PaywallNode): BuilderConfig {
  return baseConfig({ root: { type: "stack", id: "root", axis: "v", children: [node] } });
}

/** The renderer props every single-node test needs beyond `config`. */
const base = { offering, colorScheme: "light" as const, onPurchase: vi.fn() };

/** A paywall short enough to be shorter than the viewport, for scroll-container tests. */
const shortConfig = baseConfig();

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

  it("puts the content in a scroller that still fills the viewport", () => {
    const { container } = render(<PaywallRenderer config={shortConfig} {...base} />);
    const scroller = container.querySelector("[data-rov-paywall-scroll]") as HTMLElement;
    expect(scroller).not.toBeNull();
    expect(scroller.style.overflowY).toBe("auto");
    // The scroller fills the root outright — it is NOT shortened to make
    // room for a footer beside it (see the overlay tests below), and a
    // definite height is also what the content's `minHeight: 100%` resolves
    // against.
    expect(scroller.style.height).toBe("100%");
    const inner = container.querySelector("[data-rov-paywall-content]") as HTMLElement;
    // The trap: without a viewport minimum the stack stops filling and any
    // paywall pushing its CTA down with a flexible spacer collapses upward.
    expect(inner.style.minHeight).toBe("100%");
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

describe("node visibility", () => {
  function withVisibility(node: PaywallNode): BuilderConfig {
    return baseConfig({
      root: { type: "stack", id: "root", axis: "v", children: [node] },
    });
  }

  const iosOnlyText: PaywallNode = {
    type: "text",
    id: "t_ios",
    key: "title",
    role: "title",
    visibility: { platform: ["ios"] },
  };

  it("renders a platform-scoped node on that platform", () => {
    const { queryByText } = render(
      <PaywallRenderer config={withVisibility(iosOnlyText)} offering={offering} colorScheme="light" platform="ios" onPurchase={vi.fn()} />,
    );
    expect(queryByText("Go Pro")).toBeInTheDocument();
  });

  it("hides it on another platform", () => {
    const { queryByText } = render(
      <PaywallRenderer config={withVisibility(iosOnlyText)} offering={offering} colorScheme="light" platform="android" onPurchase={vi.fn()} />,
    );
    expect(queryByText("Go Pro")).not.toBeInTheDocument();
  });

  it("FAILS OPEN when the renderer does not know its platform", () => {
    const { queryByText } = render(
      <PaywallRenderer config={withVisibility(iosOnlyText)} offering={offering} colorScheme="light" onPurchase={vi.fn()} />,
    );
    expect(queryByText("Go Pro")).toBeInTheDocument();
  });

  it("takes a hidden stack's children with it", () => {
    const config = withVisibility({
      type: "stack",
      id: "hidden_stack",
      axis: "v",
      visibility: { platform: ["ios"] },
      children: [{ type: "text", id: "child", key: "title", role: "title" }],
    });
    const { queryByText } = render(
      <PaywallRenderer config={config} offering={offering} colorScheme="light" platform="android" onPurchase={vi.fn()} />,
    );
    expect(queryByText("Go Pro")).not.toBeInTheDocument();
  });

  it("does NOT render a hidden node's fallback — hidden is not a decode failure", () => {
    const config = withVisibility({
      type: "text",
      id: "t_hidden",
      key: "title",
      role: "title",
      visibility: { platform: ["ios"] },
      fallback: { type: "text", id: "t_fb", key: "subtitle", role: "body" },
    });
    const { queryByText } = render(
      <PaywallRenderer config={config} offering={offering} colorScheme="light" platform="android" onPurchase={vi.fn()} />,
    );
    expect(queryByText("Go Pro")).not.toBeInTheDocument();
    expect(queryByText("Unlock everything")).not.toBeInTheDocument();
  });
});

describe("divider and icon nodes", () => {
  it("renders a divider with its thickness and colour", () => {
    const { container } = render(
      <PaywallRenderer config={cfg({ type: "divider", id: "d1", thickness: 2 })} {...base} />,
    );
    const el = container.querySelector('[data-rov-node="d1"]') as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.style.height).toBe("2px");
  });

  it("renders a registry icon", () => {
    const { container } = render(
      <PaywallRenderer config={cfg({ type: "icon", id: "i1", name: "check" })} {...base} />,
    );
    expect(container.querySelector('[data-rov-node="i1"]')).not.toBeNull();
    expect(container.querySelector('[data-rov-node="i1"] svg')).not.toBeNull();
  });

  // Fail open: an unknown name must not throw and must not render a glyph.
  it("renders nothing for an unknown icon name", () => {
    const { container } = render(
      <PaywallRenderer config={cfg({ type: "icon", id: "i1", name: "nope" })} {...base} />,
    );
    expect(container.querySelector('[data-rov-node="i1"] svg')).toBeNull();
  });

  // Registry-coverage guard: mirrors what Swift (SF Symbol switch) and
  // Kotlin (drawableNameFor switch) each assert against icon-registry.json —
  // every semantic name in the shared registry must resolve to a real glyph
  // here too. Web is the quietest place for a miss: `Object.fromEntries`
  // stores `undefined` for an unmapped export without complaint, and
  // `Record<string, LucideIcon>` doesn't type-error on that hole.
  it.each(iconRegistry.map((entry) => entry.name))("registry icon %s resolves to a rendered glyph", (name) => {
    const { container } = render(
      <PaywallRenderer config={cfg({ type: "icon", id: "reg", name })} {...base} />,
    );
    expect(container.querySelector('[data-rov-node="reg"] svg')).not.toBeNull();
  });
});

describe("featureList, timeline and socialProof nodes", () => {
  it("renders one element per feature row", () => {
    const { container } = render(<PaywallRenderer config={cfg({
      type: "featureList", id: "f1",
      rows: [{ labelKey: "f_a" }, { labelKey: "f_b" }, { labelKey: "f_c" }],
    })} {...base} />);
    expect(container.querySelectorAll('[data-rov-row]')).toHaveLength(3);
  });

  // data-rov-icon carries the RESOLVED mark name, not just "some svg
  // rendered" — check and x are both real registry icons, so asserting svg
  // presence alone can't tell them apart (a prior version of this test made
  // that mistake and a mutated default silently passed it).
  it("resolves the default mark for an included row with no icon", () => {
    const { container } = render(<PaywallRenderer config={cfg({
      type: "featureList", id: "f1", rows: [{ labelKey: "f_a" }],
    })} {...base} />);
    expect(container.querySelector('[data-rov-row] [data-rov-icon]')?.getAttribute("data-rov-icon")).toBe("check");
  });

  it("uses the excluded mark for a row with included false", () => {
    const { container } = render(<PaywallRenderer config={cfg({
      type: "featureList", id: "f1", rows: [{ labelKey: "f_a", included: false }],
    })} {...base} />);
    expect(container.querySelector('[data-rov-row] [data-rov-icon]')?.getAttribute("data-rov-icon")).toBe("x");
  });

  it("resolves an explicit row icon over the included/excluded default", () => {
    const { container } = render(<PaywallRenderer config={cfg({
      type: "featureList", id: "f1", rows: [{ labelKey: "f_a", icon: "star", included: false }],
    })} {...base} />);
    expect(container.querySelector('[data-rov-row] [data-rov-icon]')?.getAttribute("data-rov-icon")).toBe("star");
  });

  it("renders a timeline caption's resolved text when present and omits it otherwise", () => {
    const { container } = render(<PaywallRenderer config={baseConfig({
      localizations: { en: { t_a: "Step A", t_a_cap: "Caption A", t_b: "Step B" } },
      root: {
        type: "stack", id: "root", axis: "v",
        children: [{
          type: "timeline", id: "t1",
          rows: [{ labelKey: "t_a", captionKey: "t_a_cap" }, { labelKey: "t_b" }],
        }],
      },
    })} {...base} />);
    const captions = container.querySelectorAll('[data-rov-caption]');
    expect(captions).toHaveLength(1);
    expect(captions[0]).toHaveTextContent("Caption A");
  });

  // Regression for the bug this test used to hide: the caption span was
  // previously guarded on `captionKey !== undefined` alone, so a captionKey
  // that resolves to nothing (missing from every locale) still emitted an
  // empty `<span data-rov-caption>` occupying a line box. It must be
  // guarded the same way as the label, on the RESOLVED text.
  it("omits the caption element when captionKey is present but unresolvable", () => {
    const { container } = render(<PaywallRenderer config={cfg({
      type: "timeline", id: "t1",
      rows: [{ labelKey: "t_a", captionKey: "does_not_exist_anywhere" }],
    })} {...base} />);
    expect(container.querySelectorAll('[data-rov-caption]')).toHaveLength(0);
  });

  it("renders the rating as stars, and none when rating is absent", () => {
    const withRating = render(<PaywallRenderer config={cfg({
      type: "socialProof", id: "s1", labelKey: "s", rating: 4,
    })} {...base} />);
    expect(withRating.container.querySelectorAll('[data-rov-star]').length).toBe(SOCIAL_PROOF_MAX_RATING);
    const without = render(<PaywallRenderer config={cfg({ type: "socialProof", id: "s2", labelKey: "s" })} {...base} />);
    expect(without.container.querySelectorAll('[data-rov-star]')).toHaveLength(0);
  });

  // A fractional rating fills the FLOOR, not a round-up: 4.5 must render
  // exactly 4 filled stars, not 5 — showing 4.5 identically to a full 5.0
  // overstates the rating, the wrong direction for social proof. No test
  // anywhere exercised a fractional rating before this.
  it("fills only floor(rating) stars for a fractional rating", () => {
    const { container } = render(<PaywallRenderer config={cfg({
      type: "socialProof", id: "s1", labelKey: "s", rating: 4.5,
    })} {...base} />);
    const stars = Array.from(container.querySelectorAll('[data-rov-star] svg'));
    expect(stars).toHaveLength(SOCIAL_PROOF_MAX_RATING);
    const filled = stars.filter((svg) => svg.getAttribute("fill") !== "none");
    expect(filled).toHaveLength(4);
  });

  // Fail open, exactly as an icon node does: the requested name still shows
  // up on data-rov-icon (so it's inspectable/debuggable), but no <svg> renders
  // for it — distinct from a resolved known name, which always has one.
  it("renders a row with an unknown icon without throwing", () => {
    const { container } = render(<PaywallRenderer config={cfg({
      type: "featureList", id: "f1", rows: [{ labelKey: "f_a", icon: "nope" }],
    })} {...base} />);
    const mark = container.querySelector('[data-rov-row] [data-rov-icon]');
    expect(mark?.getAttribute("data-rov-icon")).toBe("nope");
    expect(mark?.querySelector("svg")).toBeNull();
  });

  it("renders nothing for an empty rows array", () => {
    const { container } = render(<PaywallRenderer config={cfg({ type: "featureList", id: "f1", rows: [] })} {...base} />);
    expect(container.querySelectorAll('[data-rov-row]')).toHaveLength(0);
  });
});

// =====================================================================
// trialLabel vectors (P6): the CTA renders trialLabelKey only when the
// selected package's view carries a non-empty introPeriod. Driven by the
// shared render-fixtures.json contract so all renderers pin the same
// table — do not restate the cases by hand.
// =====================================================================

const RENDER_FIXTURES_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../shared/src/paywall/render-fixtures.json",
);

interface TrialLabelCase {
  name: string;
  labelKey: string;
  trialLabelKey?: string;
  selectedHasIntroPeriod: boolean | null;
  expectedKey: string;
}

/** Read once, shared by the fixture-shape guard test, the vector loop below,
 *  and the sticky-footer clearance test's by-value comparison. */
const RENDER_FIXTURES = JSON.parse(readFileSync(RENDER_FIXTURES_PATH, "utf8")) as {
  trialLabel: { cases: TrialLabelCase[] };
  defaults: Record<string, unknown>;
};

const TRIAL_LOCALIZATIONS: Record<string, string> = {
  "cta.buy": "Buy now",
  "cta.trial": "Start free trial",
};

const TRIAL_INTRO_PERIOD = "7 days";

function trialLabelConfig(c: TrialLabelCase): BuilderConfig {
  const purchaseButton: PaywallNode = {
    type: "purchaseButton",
    id: "purchase",
    labelKey: c.labelKey,
    ...(c.trialLabelKey ? { trialLabelKey: c.trialLabelKey } : {}),
  };
  // selectedHasIntroPeriod === null → no packageList, so nothing is selected.
  const children: PaywallNode[] =
    c.selectedHasIntroPeriod === null
      ? [purchaseButton]
      : [
          {
            type: "packageList",
            id: "packages",
            packageIds: ["monthly"],
            defaultSelected: "monthly",
            cellLayout: "row",
          },
          purchaseButton,
        ];
  return {
    formatVersion: 2,
    defaultLocale: "en",
    localizations: { en: { ...TRIAL_LOCALIZATIONS } },
    background: { light: "#ffffff", dark: "#000000" },
    root: { type: "stack", id: "root", axis: "v", spacing: 12, children },
  } as BuilderConfig;
}

describe("trialLabel vectors (render-fixtures contract)", () => {
  it("fixture carries the trialLabel vector section", () => {
    expect(RENDER_FIXTURES.trialLabel.cases.length).toBeGreaterThanOrEqual(4);
  });

  for (const c of RENDER_FIXTURES.trialLabel.cases) {
    it(`case: ${c.name}`, () => {
      const view: PackageView = {
        packageName: "Monthly",
        price: "$4.99",
        pricePerPeriod: "$4.99/mo",
        period: "month",
        ...(c.selectedHasIntroPeriod ? { introPeriod: TRIAL_INTRO_PERIOD } : {}),
      };
      const { container } = render(
        <PaywallRenderer
          config={trialLabelConfig(c)}
          offering={offering}
          priceView={{ monthly: view }}
          colorScheme="light"
          onPurchase={vi.fn()}
        />,
      );
      const button = container.querySelector('[data-rov-node="purchase"]') as HTMLButtonElement;
      expect(button).not.toBeNull();
      expect(button.textContent).toBe(TRIAL_LOCALIZATIONS[c.expectedKey]);
    });
  }
});

// =============================================================
// Spec §2.1 on the web, both halves of it.
//
// A paywall SHORTER than the screen must still fill the viewport AND
// DISTRIBUTE — a flexible spacer pushes, so a bottom-anchored CTA is visible
// without scrolling — while a longer one scrolls. Putting the content in a
// scroll container is what breaks that by default (available height becomes
// unbounded), which is why the content box carries `minHeight: 100%`. But a
// minimum with nothing to hand it to is the same no-op as no minimum: the
// height has to reach the root STACK, and then a flexible spacer inside that
// stack has to be the thing that absorbs it.
//
// HONEST LIMIT, stated because it decides what these tests are worth: jsdom
// runs no layout engine. Every `offsetHeight` is 0, no percentage resolves,
// no flex or grid distribution happens. So these pin the DECLARED style
// contract — which here IS the whole mechanism, since nothing about viewport
// fill is computed in JS — but they cannot prove a pixel. The pixel proof is
// browser smoke item W-1: a short paywall, text then an unsized spacer then
// the CTA, screenshotted in the canvas and the runner and diffed against iOS
// and Android at the same viewport.
// =============================================================
describe("viewport fill and flexible spacers (spec §2.1)", () => {
  /** text → spacer → CTA: the shape whose whole point is a bottom-anchored CTA. */
  function cfgPushedCta(spacer: PaywallNode): BuilderConfig {
    return baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          { type: "text", id: "body", key: "title", role: "body" },
          spacer,
          { type: "purchaseButton", id: "cta", labelKey: "purchase" },
        ],
      },
    });
  }

  const UNSIZED_SPACER: PaywallNode = { type: "spacer", id: "sp" };
  const SIZED_SPACER: PaywallNode = { type: "spacer", id: "sp", size: 24 };

  it("hands the viewport minimum on to the root stack rather than stopping at the content box", () => {
    const { container } = render(<PaywallRenderer config={shortConfig} {...base} />);
    const inner = container.querySelector("[data-rov-paywall-content]") as HTMLElement;
    expect(inner.style.minHeight).toBe("100%");
    // Grid, not a flex column, and that distinction is the finding. A flex
    // column sizes its item at flex-basis (`auto` → the stack's own content
    // height) plus `flex-grow` — and `flex-grow` cannot be set here, because
    // the root stack comes out of the generic node dispatcher, which knows
    // nothing about being at the root. `align-items: stretch` does not stand
    // in: in a column container it governs the horizontal axis. A single
    // `1fr` row stretches its item on the block axis with no cooperation
    // from the node renderer, so the stack receives max(content, minimum).
    expect(inner.style.display).toBe("grid");
    expect(inner.style.gridTemplateRows).toBe("1fr");
  });

  it("makes an UNSIZED spacer the flexible one, the way Spacer() and weight=1f are", () => {
    const { container } = render(<PaywallRenderer config={cfgPushedCta(UNSIZED_SPACER)} {...base} />);
    const spacer = container.querySelector('[data-rov-node="sp"]') as HTMLElement;
    // Without this the spacer is 0 px tall and pushes nothing: the CTA sits
    // directly under the text on the web while iOS and Android put it at the
    // bottom of the viewport, from the same JSON.
    expect(spacer.style.flexGrow).toBe("1");
    // No explicit size, so nothing overrides the growth on either axis
    // (the same node is flexible in an `h` stack too).
    expect(spacer.style.width).toBe("");
    expect(spacer.style.height).toBe("");
  });

  it("keeps a SIZED spacer at exactly its size, growing into nothing", () => {
    const { container } = render(<PaywallRenderer config={cfgPushedCta(SIZED_SPACER)} {...base} />);
    const spacer = container.querySelector('[data-rov-node="sp"]') as HTMLElement;
    // All three platforms agree that a sized spacer is a fixed gap, never a
    // distributor — growth is the UNSIZED case only.
    expect(spacer.style.flexGrow).toBe("0");
    expect(spacer.style.flexShrink).toBe("0");
    expect(spacer.style.width).toBe("24px");
    expect(spacer.style.height).toBe("24px");
  });

  it("keeps the whole chain intact for a short paywall with a pushed-down CTA", () => {
    // The two halves only work together: a stack that fills the minimum with
    // a spacer that cannot grow distributes nothing, and a growing spacer
    // inside a stack that never received the minimum has nothing to absorb.
    // Each hop below is one link of that chain, from the content box down to
    // the spacer, on the exact config the finding describes.
    const { container } = render(<PaywallRenderer config={cfgPushedCta(UNSIZED_SPACER)} {...base} />);
    const inner = container.querySelector("[data-rov-paywall-content]") as HTMLElement;
    expect(inner.style.minHeight).toBe("100%");
    expect(inner.style.display).toBe("grid");
    expect(inner.style.gridTemplateRows).toBe("1fr");

    const rootStack = container.querySelector('[data-rov-node="root"]') as HTMLElement;
    // The stretched grid item, and a column flex container, so the spacer's
    // flex-grow is on the vertical axis.
    expect(inner.firstElementChild).toBe(rootStack);
    expect(rootStack.style.display).toBe("flex");
    expect(rootStack.style.flexDirection).toBe("column");
    // A definite height here would opt the stack OUT of the grid stretch.
    expect(rootStack.style.height).toBe("");

    const spacer = container.querySelector('[data-rov-node="sp"]') as HTMLElement;
    expect(spacer.style.flexGrow).toBe("1");
    // …and the CTA is the spacer's later sibling, i.e. the thing being pushed.
    expect(spacer.nextElementSibling).toBe(container.querySelector('[data-rov-node="cta"]'));
  });

  it("still fills when a sticky footer is carving its clearance out of the minimum", () => {
    // The footered path is a separate code path for the padding, but it must
    // not lose the fill: the content box keeps its grid row, so the root
    // stack gets viewport−clearance rather than just its own content height.
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          { type: "text", id: "body", key: "title", role: "body" },
          { type: "spacer", id: "sp" },
          {
            type: "stickyFooter",
            id: "sf",
            children: [{ type: "purchaseButton", id: "cta", labelKey: "purchase" }],
          },
        ],
      },
    });
    const { container } = render(<PaywallRenderer config={config} {...base} />);
    const inner = container.querySelector("[data-rov-paywall-content]") as HTMLElement;
    expect(inner.style.display).toBe("grid");
    expect(inner.style.gridTemplateRows).toBe("1fr");
    expect(inner.style.minHeight).toBe("100%");
    expect(inner.style.boxSizing).toBe("border-box");
    expect(inner.style.paddingBottom).not.toBe("");
    expect((container.querySelector('[data-rov-node="sp"]') as HTMLElement).style.flexGrow).toBe("1");
  });
});

describe("stickyFooter and countdown nodes", () => {
  /** A stickyFooter as the LAST direct root child — the case the root pins.
   *  `rowCount` varies how many text children the footer itself carries, so
   *  tests can compare a taller footer's measured height against a shorter
   *  one's without pinning an exact pixel value. */
  function cfgWithFooter(rowCount = 1): BuilderConfig {
    return baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          { type: "text", id: "body", key: "title", role: "body" },
          {
            type: "stickyFooter",
            id: "sf",
            children: Array.from({ length: rowCount }, (_, i) => ({
              type: "text",
              id: `sf-text-${i}`,
              key: "title",
              role: "body",
            })),
          },
        ],
      },
    });
  }

  /** A stickyFooter nested inside another stack, not a direct root child at all. */
  function cfgWithNestedFooter(): BuilderConfig {
    return baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          {
            type: "stack",
            id: "wrapper",
            axis: "v",
            children: [
              {
                type: "stickyFooter",
                id: "sf",
                children: [{ type: "text", id: "sf-text", key: "title", role: "body" }],
              },
            ],
          },
          { type: "text", id: "trailing", key: "title", role: "body" },
        ],
      },
    });
  }

  function cfgCountdown(endsAt: string, onExpiry?: "freeze" | "hide"): BuilderConfig {
    return cfg({
      type: "countdown",
      id: "c1",
      endsAt,
      ...(onExpiry ? { onExpiry } : {}),
    });
  }

  it("pins a root-level stickyFooter outside the scroller", () => {
    const { container } = render(<PaywallRenderer config={cfgWithFooter()} {...base} />);
    const scroller = container.querySelector("[data-rov-paywall-scroll]")!;
    expect(scroller.querySelector('[data-rov-node="sf"]')).toBeNull();
    expect(container.querySelector('[data-rov-sticky-footer]')).not.toBeNull();
  });

  it("gives the scrolled content bottom padding so the footer never covers it", () => {
    const { container } = render(<PaywallRenderer config={cfgWithFooter()} {...base} />);
    const inner = container.querySelector("[data-rov-paywall-content]") as HTMLElement;
    expect(inner.style.paddingBottom).not.toBe("");
  });

  it("reserves the shared pre-measurement clearance until the footer has been measured", () => {
    // jsdom has no ResizeObserver, so this render never leaves the
    // un-measured state — which is precisely the first frame every platform
    // shows before it can measure. The value is hand-mirrored as `pt` in
    // RovenuePaywallView.swift and `dp` in NodeViewFactory.kt, so it is
    // pinned BY VALUE against render-fixtures.json's `defaults` (the same
    // block the native sync tests compare against) rather than against a
    // literal restated here — a literal would agree with itself forever.
    expect(typeof ResizeObserver).toBe("undefined");
    const expected = RENDER_FIXTURES.defaults.STICKY_FOOTER_CONTENT_CLEARANCE_DEFAULT;
    expect(typeof expected).toBe("number");
    const { container } = render(<PaywallRenderer config={cfgWithFooter()} {...base} />);
    const inner = container.querySelector("[data-rov-paywall-content]") as HTMLElement;
    expect(inner.style.paddingBottom).toBe(`${expected as number}px`);
  });

  it("overlays the footer on the scroll area instead of standing beside it", () => {
    const { container } = render(<PaywallRenderer config={cfgWithFooter()} {...base} />);
    const root = container.querySelector("[data-rov-paywall-root]") as HTMLElement;
    const scroller = container.querySelector("[data-rov-paywall-scroll]") as HTMLElement;
    const footer = container.querySelector("[data-rov-sticky-footer]") as HTMLElement;
    // The clearance padding above is only CORRECT under an overlay: a footer
    // laid out as a flex sibling already shortens the scroller by its own
    // height, so the padding would then reserve that height a second time.
    expect(root.style.position).toBe("relative");
    expect(scroller.style.height).toBe("100%");
    expect(footer.style.position).toBe("absolute");
    expect(footer.style.bottom).toBe("0px");
  });

  it("carves the footer clearance out of the viewport minimum rather than adding to it", () => {
    const { container } = render(<PaywallRenderer config={cfgWithFooter()} {...base} />);
    const inner = container.querySelector("[data-rov-paywall-content]") as HTMLElement;
    // content-box here would make `minHeight: 100%` mean "a viewport tall
    // PLUS the footer", so every short footered paywall would scroll by
    // exactly one footer's height of blank space.
    expect(inner.style.boxSizing).toBe("border-box");
    expect(inner.style.minHeight).toBe("100%");
  });

  it("renders a nested stickyFooter inline instead of pinning it", () => {
    const { container } = render(<PaywallRenderer config={cfgWithNestedFooter()} {...base} />);
    const scroller = container.querySelector("[data-rov-paywall-scroll]")!;
    expect(scroller.querySelector('[data-rov-node="sf"]')).not.toBeNull();
  });

  it("pins a root-level stickyFooter that is not the last child", () => {
    // The rule is "a direct child of root", not "the last child of root" —
    // a single footer authored above a sibling still means "pin this", and
    // the validator says nothing about that shape (by design), so leaving it
    // unpinned would be silent.
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          { type: "stickyFooter", id: "sf", children: [{ type: "text", id: "sf-text", key: "title", role: "body" }] },
          { type: "text", id: "trailing", key: "title", role: "body" },
        ],
      },
    });
    const { container } = render(<PaywallRenderer config={config} {...base} />);
    const scroller = container.querySelector("[data-rov-paywall-scroll]")!;
    expect(scroller.querySelector('[data-rov-node="sf"]')).toBeNull();
    expect(container.querySelector("[data-rov-sticky-footer]")).not.toBeNull();
    // …and the sibling that followed it stays in the scrolled content.
    expect(scroller.querySelector('[data-rov-node="trailing"]')).not.toBeNull();
  });

  it("pins the LAST root-level stickyFooter and leaves the earlier ones inline", () => {
    const config = baseConfig({
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          { type: "stickyFooter", id: "sfA", children: [{ type: "text", id: "sfa-text", key: "title", role: "body" }] },
          { type: "stickyFooter", id: "sfB", children: [{ type: "text", id: "sfb-text", key: "title", role: "body" }] },
          { type: "text", id: "trailing", key: "title", role: "body" },
        ],
      },
    });
    const { container } = render(<PaywallRenderer config={config} {...base} />);
    const scroller = container.querySelector("[data-rov-paywall-scroll]")!;
    const pinned = container.querySelector("[data-rov-sticky-footer]")!;
    expect(pinned.querySelector('[data-rov-node="sfB"]')).not.toBeNull();
    expect(scroller.querySelector('[data-rov-node="sfA"]')).not.toBeNull();
    expect(scroller.querySelector('[data-rov-node="sfB"]')).toBeNull();
  });

  it("formats the remaining time", () => {
    const { container } = render(
      <PaywallRenderer
        config={cfgCountdown("2027-01-01T00:00:00.000Z")}
        {...base}
        now={new Date("2026-12-31T23:59:00.000Z")}
      />,
    );
    expect(container.querySelector('[data-rov-node="c1"]')!.textContent).toContain("01:00");
  });

  it("removes a countdown whose onExpiry is hide once it has passed", () => {
    const { container } = render(
      <PaywallRenderer
        config={cfgCountdown("2026-01-01T00:00:00.000Z", "hide")}
        {...base}
        now={new Date("2027-01-01T00:00:00.000Z")}
      />,
    );
    expect(container.querySelector('[data-rov-node="c1"]')).toBeNull();
  });

  it("anchors a durationSeconds countdown to firstShownAt when the host supplies it", () => {
    // deadline = firstShownAt(00:00:00) + 120s = 00:02:00; now = 00:01:00 -> 60s remaining.
    const { container } = render(
      <PaywallRenderer
        config={cfg({ type: "countdown", id: "c1", durationSeconds: 120 })}
        {...base}
        firstShownAt={new Date("2027-01-01T00:00:00.000Z")}
        now={new Date("2027-01-01T00:01:00.000Z")}
      />,
    );
    expect(container.querySelector('[data-rov-node="c1"]')!.textContent).toContain("01:00");
  });

  // jsdom has no ResizeObserver and computes no real layout, so this stub
  // reports each observed element's height as a function of its own
  // descendant-element count — enough to make "a taller footer measures
  // taller" meaningfully true without faking real layout math. Asserting
  // the two padding values DIFFER (not exact pixels) keeps the test from
  // pinning jsdom's stand-in behaviour rather than the renderer's contract.
  class StubResizeObserver {
    #callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback;
    }
    observe(target: Element) {
      const height = target.querySelectorAll("*").length * 20;
      this.#callback(
        [{ target, contentRect: { height } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }

  it("gives a taller footer more scrolled-content padding than a shorter one", () => {
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    try {
      const { container: shortContainer } = render(<PaywallRenderer config={cfgWithFooter(1)} {...base} />);
      const { container: tallContainer } = render(<PaywallRenderer config={cfgWithFooter(6)} {...base} />);
      const shortPadding = parseFloat(
        (shortContainer.querySelector("[data-rov-paywall-content]") as HTMLElement).style.paddingBottom,
      );
      const tallPadding = parseFloat(
        (tallContainer.querySelector("[data-rov-paywall-content]") as HTMLElement).style.paddingBottom,
      );
      expect(tallPadding).toBeGreaterThan(shortPadding);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back instead of printing NaN:NaN for an unparsable endsAt", () => {
    // `endsAt` reaches the renderer as a decoded WIRE value, not as something
    // the authoring schema just validated. Both native renderers return
    // nil for an uninterpretable instant and route to `fallback`.
    const { container } = render(
      <PaywallRenderer
        config={cfg({
          type: "countdown",
          id: "c1",
          endsAt: "next tuesday",
          fallback: { type: "text", id: "cd-fallback", key: "title", role: "body" },
        })}
        {...base}
      />,
    );
    expect(container.querySelector('[data-rov-node="cd-fallback"]')).not.toBeNull();
    expect(container.textContent).not.toContain("NaN");
  });

  it("renders nothing for an unparsable endsAt with no fallback", () => {
    const { container } = render(
      <PaywallRenderer config={cfg({ type: "countdown", id: "c1", endsAt: "" })} {...base} />,
    );
    expect(container.querySelector('[data-rov-node="c1"]')).toBeNull();
    expect(container.textContent).not.toContain("NaN");
  });

  it("resolves an uncoloured countdown to the same ink as the text beside it", () => {
    // Chased to the RESOLVED colour, not to the branch: "emits no colour
    // instruction" is only correct where the ambient ink IS the paywall's,
    // which on the web it is not — the host document's colour is. Comparing
    // against a sibling text node keeps this true whatever the default ink
    // becomes, and would fail on the dark preview bug it exists for.
    const { container } = render(
      <PaywallRenderer
        config={baseConfig({
          root: {
            type: "stack",
            id: "root",
            axis: "v",
            children: [
              { type: "text", id: "plain", key: "title", role: "body" },
              { type: "countdown", id: "c1", endsAt: "2027-01-01T00:00:00.000Z" },
            ],
          },
        })}
        {...base}
        colorScheme="dark"
        now={new Date("2026-12-31T23:59:00.000Z")}
      />,
    );
    const countdownInk = (container.querySelector('[data-rov-node="c1"]') as HTMLElement).style.color;
    const textInk = (container.querySelector('[data-rov-node="plain"]') as HTMLElement).style.color;
    expect(countdownInk).not.toBe("");
    expect(countdownInk).toBe(textInk);
  });

  // ---------------------------------------------------------------
  // The countdown's clock and tick lifecycle.
  //
  // Fake timers throughout: the displayed value is computed from the WALL
  // CLOCK, so `Date.now()` has to be under the test's control for these
  // assertions to be exact rather than "within a millisecond".
  // ---------------------------------------------------------------
  describe("countdown clock", () => {
    const MOUNT_AT = new Date("2027-01-01T00:00:00.000Z");
    /** Five minutes after MOUNT_AT. */
    const DEADLINE = "2027-01-01T00:05:00.000Z";
    const DEADLINE_MS = new Date(DEADLINE).getTime();
    const ONE_MINUTE_MS = 60_000;

    afterEach(() => {
      vi.useRealTimers();
    });

    function fakeClockAt(instant: Date): void {
      vi.useFakeTimers();
      vi.setSystemTime(instant);
    }

    function countdownText(container: HTMLElement): string {
      return container.querySelector('[data-rov-node="c1"]')?.textContent ?? "";
    }

    it("recovers the whole elapsed time after its interval was throttled", () => {
      // A hidden tab clamps setInterval to roughly one call a minute, so a
      // display derived from how many ticks FIRED comes back minutes stale.
      fakeClockAt(MOUNT_AT);
      const { container, rerender } = render(
        <PaywallRenderer config={cfgCountdown(DEADLINE)} {...base} now={MOUNT_AT} />,
      );
      expect(countdownText(container)).toContain("05:00");

      act(() => {
        vi.setSystemTime(new Date(MOUNT_AT.getTime() + 2 * ONE_MINUTE_MS));
      });
      // The next repaint — whatever triggers it — must read the clock.
      rerender(<PaywallRenderer config={cfgCountdown(DEADLINE)} {...base} now={MOUNT_AT} />);
      expect(countdownText(container)).toContain("03:00");
    });

    it("does not jump forward when a parent re-render supplies a fresh now", () => {
      fakeClockAt(MOUNT_AT);
      const { container, rerender } = render(
        <PaywallRenderer config={cfgCountdown(DEADLINE)} {...base} now={MOUNT_AT} />,
      );
      act(() => {
        vi.advanceTimersByTime(30 * COUNTDOWN_TICK_MS);
      });
      expect(countdownText(container)).toContain("04:30");

      // Tapping a package re-renders the whole tree, and `props.now ?? new
      // Date()` is re-evaluated with it. Adding the ticks that already fired
      // ON TOP of that fresh instant skips the clock forward by the elapsed
      // time and then runs at double speed until the next re-render.
      rerender(
        <PaywallRenderer
          config={cfgCountdown(DEADLINE)}
          {...base}
          now={new Date(MOUNT_AT.getTime() + 30 * COUNTDOWN_TICK_MS)}
        />,
      );
      expect(countdownText(container)).toContain("04:30");
    });

    it("rounds the remaining second UP, as the SwiftUI and Android renderers do", () => {
      // 59.4 s left: the promotion has not ended, so 00:59 is a second the
      // buyer never gets — and a permanent one-second disagreement with the
      // other two renderers, since the remainder is never integral in life.
      const now = new Date(DEADLINE_MS - 59_400);
      fakeClockAt(now);
      const { container } = render(
        <PaywallRenderer config={cfgCountdown(DEADLINE)} {...base} now={now} />,
      );
      expect(countdownText(container)).toContain("01:00");
    });

    it("still shows 00:01 while any part of the last second remains", () => {
      const now = new Date(DEADLINE_MS - 1);
      fakeClockAt(now);
      const { container } = render(
        <PaywallRenderer config={cfgCountdown(DEADLINE)} {...base} now={now} />,
      );
      expect(countdownText(container)).toContain("00:01");
    });

    it("actually reaches 00:00 and freezes there", () => {
      const now = new Date(DEADLINE_MS - 2 * COUNTDOWN_TICK_MS);
      fakeClockAt(now);
      const { container } = render(
        <PaywallRenderer config={cfgCountdown(DEADLINE)} {...base} now={now} />,
      );
      expect(countdownText(container)).toContain("00:02");

      act(() => {
        vi.advanceTimersByTime(2 * COUNTDOWN_TICK_MS);
      });
      expect(countdownText(container)).toContain("00:00");

      // Frozen, not negative, and not still counting: a minute later the
      // node is still there showing the same zero.
      act(() => {
        vi.advanceTimersByTime(ONE_MINUTE_MS);
      });
      expect(countdownText(container)).toContain("00:00");
    });

    it("parks the tick while the paywall is off-screen and resumes when it returns", () => {
      const observers: StubIntersectionObserver[] = [];
      class StubIntersectionObserver {
        #callback: IntersectionObserverCallback;
        constructor(callback: IntersectionObserverCallback) {
          this.#callback = callback;
          observers.push(this);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
        emit(isIntersecting: boolean) {
          this.#callback(
            [{ isIntersecting } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
        }
      }
      vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
      try {
        fakeClockAt(MOUNT_AT);
        const { container } = render(
          <PaywallRenderer config={cfgCountdown(DEADLINE)} {...base} now={MOUNT_AT} />,
        );
        const observer = observers[0]!;

        act(() => observer.emit(false));
        act(() => {
          vi.advanceTimersByTime(ONE_MINUTE_MS);
        });
        // A minute of clock passed with nothing repainted: the tick is parked.
        expect(countdownText(container)).toContain("05:00");

        // Coming back is the half that is easy to leave unimplemented.
        act(() => observer.emit(true));
        expect(countdownText(container)).toContain("04:00");
        act(() => {
          vi.advanceTimersByTime(COUNTDOWN_TICK_MS);
        });
        expect(countdownText(container)).toContain("03:59");
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("parks the tick while the tab is hidden and resumes on return", () => {
      let hidden = false;
      const original = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => (hidden ? "hidden" : "visible"),
      });
      try {
        fakeClockAt(MOUNT_AT);
        const { container } = render(
          <PaywallRenderer config={cfgCountdown(DEADLINE)} {...base} now={MOUNT_AT} />,
        );

        hidden = true;
        act(() => {
          document.dispatchEvent(new Event("visibilitychange"));
        });
        act(() => {
          vi.advanceTimersByTime(ONE_MINUTE_MS);
        });
        expect(countdownText(container)).toContain("05:00");

        hidden = false;
        act(() => {
          document.dispatchEvent(new Event("visibilitychange"));
        });
        expect(countdownText(container)).toContain("04:00");
      } finally {
        delete (document as unknown as Record<string, unknown>).visibilityState;
        if (original) Object.defineProperty(Document.prototype, "visibilityState", original);
      }
    });

    it("keeps a durationSeconds deadline across a remount when the host persists the anchor", () => {
      // The whole point of the persisted anchor: reopening the paywall two
      // minutes later must show three minutes left, not five.
      const DURATION_SECONDS = 300;
      const config = cfg({ type: "countdown", id: "c1", durationSeconds: DURATION_SECONDS });
      localStorage.clear();
      fakeClockAt(MOUNT_AT);
      const first = render(
        <PaywallRenderer
          config={config}
          {...base}
          firstShownAt={resolvePersistedFirstShownAt("pw_1", MOUNT_AT)}
          now={MOUNT_AT}
        />,
      );
      expect(countdownText(first.container)).toContain("05:00");
      first.unmount();

      const laterOpen = new Date(MOUNT_AT.getTime() + 2 * ONE_MINUTE_MS);
      act(() => {
        vi.setSystemTime(laterOpen);
      });
      const second = render(
        <PaywallRenderer
          config={config}
          {...base}
          firstShownAt={resolvePersistedFirstShownAt("pw_1", laterOpen)}
          now={laterOpen}
        />,
      );
      expect(countdownText(second.container)).toContain("03:00");
      localStorage.clear();
    });
  });
});

describe("carousel node", () => {
  function textNode(key: string): PaywallNode {
    return { type: "text", id: key, key, role: "body" };
  }

  const pageA = textNode("pageA");
  const pageB = textNode("pageB");
  const pageC = textNode("pageC");

  /** Every text key referenced anywhere under `node` (pages, fallback),
   *  mapped to itself — this is what makes `textNode("nope")` actually
   *  render the literal string "nope" rather than an empty/missing
   *  localization. */
  function collectTextKeys(node: PaywallNode | undefined, into: Record<string, string>): void {
    if (!node) return;
    if (node.type === "text") into[node.key] = node.key;
    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children) collectTextKeys(child, into);
    }
    collectTextKeys(node.fallback, into);
  }

  type CarouselOptions = Partial<Omit<CarouselNode, "type" | "id">>;

  /**
   * Builds a single-carousel paywall from either `(...pages)` or
   * `(...pages, options)` — the last arg is treated as `options` when it
   * has no `type` field, since every real page (a `PaywallNode`) has one.
   * `options.children`, when given, REPLACES the page list entirely (this
   * is how the "empty carousel" case is expressed: `carouselWith({
   * children: [], fallback: textNode("nope") })`).
   */
  function carouselWith(...args: Array<PaywallNode | CarouselOptions>): BuilderConfig {
    const rest = [...args];
    const last = rest[rest.length - 1];
    const hasOptions = rest.length > 0 && typeof last === "object" && last !== null && !("type" in last);
    const options = (hasOptions ? rest.pop() : {}) as CarouselOptions;
    const pages = rest as PaywallNode[];
    const node: CarouselNode = {
      type: "carousel",
      id: "carousel-1",
      children: pages,
      ...options,
    };
    const localizations: Record<string, string> = {};
    for (const page of node.children) collectTextKeys(page, localizations);
    collectTextKeys(node.fallback, localizations);
    return {
      formatVersion: 2,
      defaultLocale: "en",
      localizations: { en: localizations },
      background: { light: "#ffffff", dark: "#000000" },
      root: { type: "stack", id: "root", axis: "v", children: [node] },
    };
  }

  function renderPaywall(config: BuilderConfig) {
    return render(
      <PaywallRenderer config={config} offering={offering} colorScheme="light" onPurchase={vi.fn()} />,
    );
  }

  function trackScrollLeft(container: HTMLElement): number {
    return (container.querySelector("[data-rov-carousel-track]") as HTMLElement).scrollLeft;
  }

  function dotOpacities(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("[data-rov-carousel-dot]")).map(
      (dot) => (dot as HTMLElement).style.opacity,
    );
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders each child once", () => {
    const { container } = renderPaywall(carouselWith(pageA, pageB, pageC));
    expect(container.querySelectorAll("[data-rov-carousel-page]")).toHaveLength(3);
  });

  it("draws one dot per page when showsIndicator is absent", () => {
    const { container } = renderPaywall(carouselWith(pageA, pageB));
    expect(container.querySelectorAll("[data-rov-carousel-dot]")).toHaveLength(2);
  });

  it("draws no dots when showsIndicator is false", () => {
    const { container } = renderPaywall(carouselWith(pageA, pageB, { showsIndicator: false }));
    expect(container.querySelectorAll("[data-rov-carousel-dot]")).toHaveLength(0);
  });

  it("declares mandatory x snapping on the track", () => {
    const { container } = renderPaywall(carouselWith(pageA, pageB));
    const track = container.querySelector("[data-rov-carousel-track]") as HTMLElement;
    expect(track.style.scrollSnapType).toBe("x mandatory");
  });

  it("renders fallback for an empty carousel", () => {
    const { container } = renderPaywall(carouselWith({ children: [], fallback: textNode("nope") }));
    expect(container.textContent).toContain("nope");
  });

  it("drops a page hidden by visibility — no blank page, no phantom dot (C3)", () => {
    // The decided cross-platform contract (Android's original behaviour):
    // a hidden page is DROPPED, not rendered as a blank slot with a dot
    // that lies about how much content exists. Middle page hidden on
    // android, three authored, two renderable.
    const hiddenPage: PaywallNode = {
      type: "text",
      id: "hiddenPage",
      key: "hiddenPage",
      role: "body",
      visibility: { platform: ["ios"] },
    };
    const config = carouselWith(pageA, hiddenPage, pageB);
    const { container } = render(
      <PaywallRenderer config={config} offering={offering} colorScheme="light" platform="android" onPurchase={vi.fn()} />,
    );
    expect(container.querySelectorAll("[data-rov-carousel-page]")).toHaveLength(2);
    expect(container.querySelectorAll("[data-rov-carousel-dot]")).toHaveLength(2);
  });

  it("renders the carousel's fallback when every page is hidden by visibility (C3)", () => {
    const hiddenA: PaywallNode = {
      type: "text",
      id: "hiddenA",
      key: "hiddenA",
      role: "body",
      visibility: { platform: ["ios"] },
    };
    const hiddenB: PaywallNode = {
      type: "text",
      id: "hiddenB",
      key: "hiddenB",
      role: "body",
      visibility: { platform: ["ios"] },
    };
    const config = carouselWith(hiddenA, hiddenB, { fallback: textNode("nope") });
    const { container } = render(
      <PaywallRenderer config={config} offering={offering} colorScheme="light" platform="android" onPurchase={vi.fn()} />,
    );
    expect(container.textContent).toContain("nope");
    expect(container.querySelectorAll("[data-rov-carousel-page]")).toHaveLength(0);
    expect(container.querySelectorAll("[data-rov-carousel-dot]")).toHaveLength(0);
  });

  /** The four ways a page can draw nothing WITHOUT being hidden by a
   *  `visibility` rule — the half of the empty-page rule that web and iOS
   *  were missing and Android already had. Each is a page whose renderer
   *  legitimately produces no content: an undecodable node type with nowhere
   *  to fall back to, an icon name this build's registry does not know, a
   *  countdown carrying neither `endsAt` nor `durationSeconds`, and a nested
   *  carousel with no pages of its own. */
  const emptyPages: PaywallNode[] = [
    { type: "totally-unknown", id: "unknownPage" } as unknown as PaywallNode,
    { type: "icon", id: "unknownIconPage", name: "definitely-not-a-registry-icon" },
    { type: "countdown", id: "deadlinelessPage" },
    { type: "carousel", id: "nestedEmptyPage", children: [] },
  ];

  it("drops a page that renders nothing at all — no blank page, no phantom dot (C3)", () => {
    // Android's rule, which web now matches: the drop is keyed on "this page
    // produced no content", not on "this page was hidden by `visibility`".
    // Six authored pages, four of which draw nothing; two renderable.
    const config = carouselWith(pageA, ...emptyPages, pageB);
    const { container } = renderPaywall(config);
    expect(container.querySelectorAll("[data-rov-carousel-page]")).toHaveLength(2);
    expect(container.querySelectorAll("[data-rov-carousel-dot]")).toHaveLength(2);
    // ...and the two survivors are the two real ones, in order — a count
    // alone would pass even if the wrong pair survived.
    expect(container.textContent).toContain("pageA");
    expect(container.textContent).toContain("pageB");
  });

  it("renders the carousel's fallback when every page renders nothing (C3)", () => {
    const config = carouselWith(...emptyPages, { fallback: textNode("nope") });
    const { container } = renderPaywall(config);
    expect(container.textContent).toContain("nope");
    expect(container.querySelectorAll("[data-rov-carousel-page]")).toHaveLength(0);
    expect(container.querySelectorAll("[data-rov-carousel-dot]")).toHaveLength(0);
  });

  it("renders nothing at all when every page renders nothing and there is no fallback (C3)", () => {
    const { container } = renderPaywall(carouselWith(...emptyPages));
    expect(container.querySelector("[data-rov-carousel-track]")).toBeNull();
    expect(container.querySelectorAll("[data-rov-carousel-page]")).toHaveLength(0);
    expect(container.querySelectorAll("[data-rov-carousel-dot]")).toHaveLength(0);
  });

  it("does not crash on a single-page carousel, and draws no indicator (I2)", () => {
    // Web used to be the outlier here, drawing one lone dot where both
    // natives draw none (iOS `.automatic`, Android `pageCount > 1`) — this
    // test used to PIN that divergence; it now asserts the corrected,
    // cross-platform-agreed behaviour.
    const { container } = renderPaywall(carouselWith(pageA));
    expect(container.querySelectorAll("[data-rov-carousel-page]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-rov-carousel-dot]")).toHaveLength(0);
  });

  it("stops the auto-advance interval when the document hides", () => {
    vi.useFakeTimers();
    const original = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      const { container } = renderPaywall(carouselWith(pageA, pageB, { autoAdvanceSeconds: 3 }));
      fireEvent(document, new Event("visibilitychange"));
      const before = trackScrollLeft(container);
      vi.advanceTimersByTime(10_000);
      expect(trackScrollLeft(container)).toBe(before);
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
      if (original) Object.defineProperty(Document.prototype, "visibilityState", original);
    }
  });

  it("parks the tick while off-screen and resumes when it returns, per the countdown lifecycle", () => {
    const observers: StubIntersectionObserver[] = [];
    class StubIntersectionObserver {
      #callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) {
        this.#callback = callback;
        observers.push(this);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      emit(isIntersecting: boolean) {
        this.#callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
    }
    vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
    vi.useFakeTimers();
    try {
      const { container } = renderPaywall(carouselWith(pageA, pageB, pageC, { autoAdvanceSeconds: 2 }));
      const observer = observers[0]!;

      act(() => observer.emit(false));
      act(() => vi.advanceTimersByTime(10_000));
      expect(dotOpacities(container)[0]).toBe(String(CAROUSEL_DOT_ACTIVE_OPACITY));

      act(() => observer.emit(true));
      act(() => vi.advanceTimersByTime(2_000));
      expect(dotOpacities(container)[1]).toBe(String(CAROUSEL_DOT_ACTIVE_OPACITY));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("wraps to the first page when loop is true", () => {
    vi.useFakeTimers();
    const { container } = renderPaywall(carouselWith(pageA, pageB, pageC, { autoAdvanceSeconds: 2, loop: true }));
    act(() => vi.advanceTimersByTime(2_000)); // -> page 1
    act(() => vi.advanceTimersByTime(2_000)); // -> page 2 (last)
    act(() => vi.advanceTimersByTime(2_000)); // -> wraps to page 0
    expect(dotOpacities(container)).toEqual([
      String(CAROUSEL_DOT_ACTIVE_OPACITY),
      String(CAROUSEL_DOT_INACTIVE_OPACITY),
      String(CAROUSEL_DOT_INACTIVE_OPACITY),
    ]);
  });

  it("stops permanently on the last page when loop is false, without rewinding", () => {
    vi.useFakeTimers();
    const { container } = renderPaywall(carouselWith(pageA, pageB, pageC, { autoAdvanceSeconds: 2, loop: false }));
    act(() => vi.advanceTimersByTime(2_000)); // -> page 1
    act(() => vi.advanceTimersByTime(2_000)); // -> page 2 (last)
    act(() => vi.advanceTimersByTime(10_000)); // would wrap or crash if mishandled
    expect(dotOpacities(container)).toEqual([
      String(CAROUSEL_DOT_INACTIVE_OPACITY),
      String(CAROUSEL_DOT_INACTIVE_OPACITY),
      String(CAROUSEL_DOT_ACTIVE_OPACITY),
    ]);
  });

  it("restarts the auto-advance wait when the user scrolls by hand, instead of racing it", () => {
    vi.useFakeTimers();
    const { container } = renderPaywall(carouselWith(pageA, pageB, pageC, { autoAdvanceSeconds: 2 }));
    const track = container.querySelector("[data-rov-carousel-track]") as HTMLElement;

    // Just short of the first scheduled tick, the user swipes to page 1 by hand.
    act(() => vi.advanceTimersByTime(1_900));
    act(() => fireEvent.scroll(track, { target: { scrollLeft: 1 } }));
    expect(dotOpacities(container)[1]).toBe(String(CAROUSEL_DOT_ACTIVE_OPACITY));

    // The OLD schedule would have fired ~100ms after the swipe. It must not:
    // the wait restarted, so page 1 is still current a moment later.
    act(() => vi.advanceTimersByTime(200));
    expect(dotOpacities(container)[1]).toBe(String(CAROUSEL_DOT_ACTIVE_OPACITY));

    // A full interval after the swipe, the restarted timer fires.
    act(() => vi.advanceTimersByTime(1_800));
    expect(dotOpacities(container)[2]).toBe(String(CAROUSEL_DOT_ACTIVE_OPACITY));
  });

  it("resolves an explicit indicatorColor onto every dot", () => {
    const { container } = renderPaywall(
      carouselWith(pageA, pageB, { indicatorColor: { light: "#ff0000", dark: "#00ff00" } }),
    );
    const dots = container.querySelectorAll("[data-rov-carousel-dot]");
    for (const dot of Array.from(dots)) {
      expect((dot as HTMLElement).style.color).toBe("rgb(255, 0, 0)");
    }
  });

  it("resolves an absent indicatorColor to the paywall's own ink, not the host page's (I1)", () => {
    // Judged at the RESOLVED colour, per spec §3.2 — a passed-through
    // `undefined` (the previous behaviour) would also read as "no inline
    // instruction" and pass a branch-only assertion, which is exactly the
    // shape of bug this rule exists to catch: jsdom has no ambient `color`
    // on the document, so a `currentColor` pass-through and a genuine
    // resolved-ink substitution are indistinguishable by an emptiness check
    // alone. rgb(15, 23, 42) is `DEFAULT_INK.light` (#0F172A) — the same
    // light-mode ink `resolveTextColor` gives every other uncoloured text
    // node on this renderer, and byte-identical to Android's
    // `resolvedInkTintColorInt` for the same case.
    const { container } = renderPaywall(carouselWith(pageA, pageB));
    const dots = container.querySelectorAll("[data-rov-carousel-dot]");
    for (const dot of Array.from(dots)) {
      expect((dot as HTMLElement).style.color).toBe("rgb(15, 23, 42)");
    }
  });
});

describe("resolvePersistedFirstShownAt", () => {
  const FIRST_OPEN = new Date("2027-01-01T00:00:00.000Z");
  const LATER_OPEN = new Date("2027-01-01T00:10:00.000Z");

  afterEach(() => {
    localStorage.clear();
  });

  it("stamps on the first call and reads that same instant back afterwards", () => {
    const first = resolvePersistedFirstShownAt("pw_1", FIRST_OPEN);
    const second = resolvePersistedFirstShownAt("pw_1", LATER_OPEN);
    expect(first?.getTime()).toBe(FIRST_OPEN.getTime());
    expect(second?.getTime()).toBe(FIRST_OPEN.getTime());
  });

  it("writes the same key the iOS and Android SDKs use", () => {
    resolvePersistedFirstShownAt("pw_1", FIRST_OPEN);
    expect(localStorage.getItem(`${COUNTDOWN_FIRST_SHOWN_AT_KEY_PREFIX}pw_1`)).toBe(
      String(FIRST_OPEN.getTime()),
    );
  });

  it("keys the anchor per paywall", () => {
    resolvePersistedFirstShownAt("pw_1", FIRST_OPEN);
    const other = resolvePersistedFirstShownAt("pw_2", LATER_OPEN);
    expect(other?.getTime()).toBe(LATER_OPEN.getTime());
  });

  it("collapses an absent identifier to the empty suffix, as the natives do", () => {
    resolvePersistedFirstShownAt(undefined, FIRST_OPEN);
    expect(localStorage.getItem(COUNTDOWN_FIRST_SHOWN_AT_KEY_PREFIX)).toBe(String(FIRST_OPEN.getTime()));
  });

  it("re-stamps a corrupt stored value rather than returning an invalid date", () => {
    localStorage.setItem(`${COUNTDOWN_FIRST_SHOWN_AT_KEY_PREFIX}pw_1`, "whenever");
    const resolved = resolvePersistedFirstShownAt("pw_1", FIRST_OPEN);
    expect(resolved?.getTime()).toBe(FIRST_OPEN.getTime());
  });
});
