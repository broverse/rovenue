import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import "../../../i18n/config";
import { TEMPLATES } from "../templates";
import { TemplatePreview } from "../template-preview";

// =============================================================
// The gallery card renders each template's REAL tree through the real
// renderer against a synthetic offering. That path is what these tests
// pin: a template using a node the renderer cannot draw without a real
// offering, or copy that never reaches the card, would otherwise only
// show up as a blank card in the product.
// =============================================================

const SCALE = 0.44;

describe("TemplatePreview", () => {
  it("renders every catalogue template without throwing", () => {
    for (const template of TEMPLATES) {
      const { unmount } = render(
        <TemplatePreview config={template.build("en")} scale={SCALE} colorScheme="light" />,
      );
      unmount();
    }
    expect(TEMPLATES.length).toBeGreaterThan(0);
  });

  it("shows the template's real copy, not an abstract silhouette", () => {
    const hero = TEMPLATES.find((t) => t.id === "hero")!;
    const config = hero.build("en");
    const title = config.localizations.en!["hero_head_title"]!;
    const { getByText } = render(
      <TemplatePreview config={config} scale={SCALE} colorScheme="light" />,
    );
    expect(getByText(title)).toBeTruthy();
  });

  it("renders the placeholder prices, so a card shows a plan list rather than an empty one", () => {
    const comparison = TEMPLATES.find((t) => t.id === "comparison")!;
    const { container } = render(
      <TemplatePreview config={comparison.build("en")} scale={SCALE} colorScheme="light" />,
    );
    // `placeholderPriceView` cycles $9.99 / $59.99 / $2.99 across the three
    // synthetic packages; any of them appearing proves the priceView reached
    // the renderer rather than the cells rendering blank.
    expect(container.textContent).toContain("$9.99");
  });

  it("keeps the footer's Restore link visible", () => {
    // The renderer HIDES a restore control when the host supplies no
    // `onRestore` handler. The preview passes a noop precisely so the card
    // does not show a footer the author will never see — this test is what
    // stops that noop being 'cleaned up' as dead.
    const hero = TEMPLATES.find((t) => t.id === "hero")!;
    const config = hero.build("en");
    const restore = config.localizations.en!["hero_foot_restore"]!;
    const { container } = render(
      <TemplatePreview config={config} scale={SCALE} colorScheme="light" />,
    );
    expect(container.textContent).toContain(restore);
  });

  it("renders inertly — the card is a picture, not a set of controls", () => {
    const hero = TEMPLATES.find((t) => t.id === "hero")!;
    const { container } = render(
      <TemplatePreview config={hero.build("en")} scale={SCALE} colorScheme="light" />,
    );
    const outer = container.firstElementChild as HTMLElement;
    expect(outer.style.pointerEvents).toBe("none");
    expect(outer.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders in dark scheme without throwing", () => {
    const hero = TEMPLATES.find((t) => t.id === "hero")!;
    const { container } = render(
      <TemplatePreview config={hero.build("en")} scale={SCALE} colorScheme="dark" />,
    );
    expect(container.textContent).toBeTruthy();
  });
});
