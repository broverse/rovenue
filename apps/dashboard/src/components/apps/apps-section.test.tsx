import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../tests/msw/server";
import { renderWithRouter } from "../../../tests/render";
import { AppsSection } from "./apps-section";
import type { AppDescriptor } from "./types";

const META_CAPI_APP: AppDescriptor = {
  id: "meta-capi",
  category: "ads",
  vendorKey: "meta",
  logo: { background: "#1877F2", glyph: "M" },
  status: "available",
};

describe("AppsSection — M6.12", () => {
  it("clicking meta-capi card triggers onOpenIntegration", async () => {
    const user = userEvent.setup();
    const onOpenIntegration = vi.fn();

    server.use(
      http.get(
        "http://localhost:3000/dashboard/projects/p1/integrations",
        () => HttpResponse.json({ data: [] }),
      ),
    );

    const { container } = renderWithRouter(
      <AppsSection
        category="ads"
        apps={[META_CAPI_APP]}
        totalCount={1}
        onViewAll={vi.fn()}
        onOpenIntegration={onOpenIntegration}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("article")).toBeTruthy();
    });

    const article = container.querySelector("article")!;
    await user.click(article);

    expect(onOpenIntegration).toHaveBeenCalledOnce();
    expect(onOpenIntegration).toHaveBeenCalledWith("meta-capi");
  });
});
