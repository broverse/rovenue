import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../../tests/msw/server";
import { renderWithRouter } from "../../../../tests/render";
import { IntegrationDrawer } from "./integration-drawer";

describe("IntegrationDrawer — M6.16 e2e happy path", () => {
  it("full flow: credentials → validate → 4× Next → Activate calls onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    server.use(
      http.post(
        "http://localhost:3000/dashboard/projects/p1/integrations/validate",
        () => HttpResponse.json({ data: { ok: true } }),
      ),
      http.post(
        "http://localhost:3000/dashboard/projects/p1/integrations",
        () => HttpResponse.json({ data: { id: "new1" } }, { status: 201 }),
      ),
      http.patch(
        "http://localhost:3000/dashboard/projects/p1/integrations/new1",
        () =>
          HttpResponse.json({
            data: {
              id: "new1",
              providerId: "META_CAPI",
              displayName: "Meta Conversions API",
              credentialsHint: "…1234",
              enabledEvents: ["revenue.INITIAL"],
              eventMapping: {},
              actionSource: "app",
              testEventCode: null,
              isEnabled: true,
              lastValidatedAt: null,
              lastError: null,
              lastBackfillAt: null,
              createdAt: "2026-05-28T00:00:00Z",
              updatedAt: "2026-05-28T00:00:00Z",
            },
          }),
      ),
    );

    renderWithRouter(
      <IntegrationDrawer
        open={true}
        onClose={onClose}
        projectId="p1"
        providerId="META_CAPI"
        existingConnection={null}
      />,
    );

    // Step 1 — Credentials: dialog should be open
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeTruthy();

    // Fill in Pixel ID
    const pixelInput = await screen.findByLabelText(/pixel id/i);
    await user.type(pixelInput, "123456789");

    // Fill in Access Token
    const tokenInput = screen.getByLabelText(/access token/i);
    await user.type(tokenInput, "tok_abcd1234");

    // Click Validate
    const validateBtn = screen.getByRole("button", { name: /validate/i });
    await user.click(validateBtn);

    // Wait for Next button to become enabled (validation succeeded)
    const nextBtn = await screen.findByRole("button", { name: /^next$/i });
    await waitFor(() => {
      expect((nextBtn as HTMLButtonElement).disabled).toBe(false);
    });

    // Click Next → goes to events step
    await user.click(nextBtn);

    // Step 2 — Events: need to select at least one event, then click Next
    await screen.findByText(/choose which events/i);
    // Select the first event checkbox
    const firstCheckbox = screen.getAllByRole("checkbox")[0];
    await user.click(firstCheckbox);

    // Now Next should be enabled
    const eventsNextBtn = screen.getByRole("button", { name: /^next$/i });
    await waitFor(() => {
      expect((eventsNextBtn as HTMLButtonElement).disabled).toBe(false);
    });
    await user.click(eventsNextBtn);

    // Step 3 — Mapping: click Next
    await screen.findByText(/customize event names/i);
    const mappingNextBtn = screen.getByRole("button", { name: /^next$/i });
    await user.click(mappingNextBtn);

    // Step 4 — Test: click Next
    await screen.findByText(/send a test event/i);
    const testNextBtn = screen.getByRole("button", { name: /^next$/i });
    await user.click(testNextBtn);

    // Step 5 — Activate: click Activate
    await screen.findByText(/configuration summary/i);
    const activateBtn = screen.getByRole("button", { name: /^activate$/i });
    await user.click(activateBtn);

    // Assert onClose was called
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
