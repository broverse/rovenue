import { describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "../../../tests/render";
import { AppCard } from "./app-card";
import type { AppDescriptor } from "./types";

const META_CAPI_APP: AppDescriptor = {
  id: "meta-capi",
  category: "ads",
  vendorKey: "meta",
  logo: { background: "#1877F2", glyph: "M" },
  status: "available",
};

const SNAPCHAT_UNAVAILABLE_APP: AppDescriptor = {
  id: "snapchat-ads",
  category: "ads",
  vendorKey: "snap",
  logo: { background: "#FFFC00", glyph: "S", textColor: "#000" },
  // "unavailable" is not in AppStatus union but the guard checks !== "unavailable"
  status: "unavailable" as AppDescriptor["status"],
};

describe("AppCard — M6.11", () => {
  it("clicking meta-capi card calls onOpenIntegration with 'meta-capi'", async () => {
    const user = userEvent.setup();
    const onOpenIntegration = vi.fn();

    const { container } = renderWithRouter(
      <AppCard
        app={META_CAPI_APP}
        onOpenIntegration={onOpenIntegration}
      />,
    );

    // Wait for component to render (the article element)
    await waitFor(() => {
      const article = container.querySelector("article");
      expect(article).toBeTruthy();
    });

    const article = container.querySelector("article")!;
    await user.click(article);

    expect(onOpenIntegration).toHaveBeenCalledOnce();
    expect(onOpenIntegration).toHaveBeenCalledWith("meta-capi");
  });

  it("clicking unavailable snapchat-ads card does NOT call onOpenIntegration", async () => {
    const user = userEvent.setup();
    const onOpenIntegration = vi.fn();

    const { container } = renderWithRouter(
      <AppCard
        app={SNAPCHAT_UNAVAILABLE_APP}
        onOpenIntegration={onOpenIntegration}
      />,
    );

    await waitFor(() => {
      const article = container.querySelector("article");
      expect(article).toBeTruthy();
    });

    // The unavailable card's article has no onClick, so clicking it should not trigger
    const article = container.querySelector("article")!;
    await user.click(article);

    expect(onOpenIntegration).not.toHaveBeenCalled();
  });
});
