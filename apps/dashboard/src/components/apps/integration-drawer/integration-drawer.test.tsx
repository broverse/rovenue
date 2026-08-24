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
    // The header shows "Credentials — Step 1 of 5"; and the step renders a Pixel ID field
    expect(screen.getByText(/credentials/i)).toBeTruthy();
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

  it("CUSTOM_WEBHOOK drawer shows the URL field, not the ad-provider pixel fields", async () => {
    renderWithRouter(
      <IntegrationDrawer
        open={true}
        onClose={vi.fn()}
        projectId="p1"
        providerId="CUSTOM_WEBHOOK"
        existingConnection={null}
      />,
    );

    expect(await screen.findByLabelText(/endpoint url/i)).toBeTruthy();
    expect(screen.queryByLabelText(/pixel/i)).toBeNull();
    expect(screen.queryByLabelText(/access token/i)).toBeNull();
    // 3-step wizard (credentials/events/activate), not the 5-step ad flow.
    expect(screen.getByText(/step 1 of 3/i)).toBeTruthy();
  });
});
