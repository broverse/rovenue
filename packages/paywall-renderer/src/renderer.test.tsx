import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { BuilderConfig, PaywallNode } from "@rovenue/shared/paywall";
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
});
