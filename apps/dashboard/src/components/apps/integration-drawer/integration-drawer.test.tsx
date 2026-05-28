import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithRouter } from "../../../../tests/render";
import { IntegrationDrawer } from "./integration-drawer";

describe("IntegrationDrawer shell", () => {
  it("renders Step 1 (credentials) when there is no existing connection", async () => {
    renderWithRouter(
      <IntegrationDrawer
        open={true}
        onClose={vi.fn()}
        projectId="p1"
        providerId="META_CAPI"
        existingConnection={null}
      />,
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(screen.getByText("Credentials")).toBeTruthy();
  });

  it("renders nothing when open=false", () => {
    renderWithRouter(
      <IntegrationDrawer
        open={false}
        onClose={vi.fn()}
        projectId="p1"
        providerId="META_CAPI"
        existingConnection={null}
      />,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
