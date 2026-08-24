import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../../tests/msw/server";
import { renderWithRouter } from "../../../../tests/render";
import { IntegrationDrawer } from "./integration-drawer";

describe("IntegrationDrawer — M6.16 e2e happy path", () => {
  it("full flow: credentials → validate → 4× Next → Activate calls onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const createSpy = vi.fn();

    server.use(
      http.post("http://localhost:3000/dashboard/projects/p1/integrations/validate", () =>
        HttpResponse.json({ data: { ok: true } }),
      ),
      http.post(
        "http://localhost:3000/dashboard/projects/p1/integrations",
        // Both routes wrap the row: `ok({ connection: row })` —
        // apps/api/src/routes/dashboard/integrations.ts:289 and :545.
        async ({ request }) => {
          createSpy(await request.json());
          return HttpResponse.json({ data: { connection: { id: "new1" } } }, { status: 201 });
        },
      ),
      http.patch("http://localhost:3000/dashboard/projects/p1/integrations/new1", () =>
        HttpResponse.json({
          data: {
            connection: {
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

    // Regression guard: the create body must carry the backend's
    // snake_case credential ids (pixel_id / access_token), not the
    // camelCase ids the drawer used to send.
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: { pixel_id: "123456789", access_token: "tok_abcd1234" },
      }),
    );
  });

  it("CUSTOM_WEBHOOK full flow: create endpoint → copy secret → select events → Activate calls onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    const WEBHOOK_CONNECTION = {
      id: "wh1",
      providerId: "CUSTOM_WEBHOOK",
      displayName: "api.example.com",
      credentialsHint: "api.example.com · …cret",
      enabledEvents: [] as string[],
      eventMapping: {},
      actionSource: "app",
      testEventCode: null,
      isEnabled: false,
      lastValidatedAt: null,
      lastError: null,
      lastBackfillAt: null,
      createdAt: "2026-08-24T00:00:00Z",
      updatedAt: "2026-08-24T00:00:00Z",
    };

    server.use(
      http.post(
        "http://localhost:3000/dashboard/projects/p1/integrations",
        () =>
          HttpResponse.json(
            { data: { connection: WEBHOOK_CONNECTION, secret: "whsec_supersecret" } },
            { status: 201 },
          ),
      ),
      http.patch("http://localhost:3000/dashboard/projects/p1/integrations/wh1", () =>
        HttpResponse.json({
          data: { connection: { ...WEBHOOK_CONNECTION, isEnabled: true, enabledEvents: ["revenue.INITIAL"] } },
        }),
      ),
    );

    renderWithRouter(
      <IntegrationDrawer
        open={true}
        onClose={onClose}
        projectId="p1"
        providerId="CUSTOM_WEBHOOK"
        existingConnection={null}
      />,
    );

    // Wait for the dialog (and its Base UI focus-trap) to fully settle
    // before typing — starting to type immediately races the dialog's
    // open-transition focus assertion and can drop keystrokes.
    await screen.findByRole("dialog");

    // Step 1 — Credentials: URL field, create the endpoint.
    const urlInput = await screen.findByLabelText(/endpoint url/i);
    await user.type(urlInput, "https://api.example.com/hooks");
    await user.click(screen.getByRole("button", { name: /create endpoint/i }));

    // Secret shown once, then Next.
    expect(await screen.findByText("whsec_supersecret")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^next$/i }));

    // Step 2 — Events: select one, Next.
    await screen.findByText(/choose which events/i);
    const firstCheckbox = screen.getAllByRole("checkbox")[0];
    await user.click(firstCheckbox);
    const eventsNextBtn = screen.getByRole("button", { name: /^next$/i });
    await waitFor(() => expect((eventsNextBtn as HTMLButtonElement).disabled).toBe(false));
    await user.click(eventsNextBtn);

    // Step 3 — Activate (no mapping/test steps for CUSTOM_WEBHOOK).
    await screen.findByText(/configuration summary/i);
    await user.click(screen.getByRole("button", { name: /^activate$/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
