import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../../tests/msw/server";
import { renderWithRouter } from "../../../../tests/render";
import { StepActivate } from "./step-activate";
import type { DrawerState } from "./integration-drawer";
import type { IntegrationConnectionRow } from "../../../lib/hooks/useProjectIntegrations";

const BASE_STATE: DrawerState = {
  step: "activate",
  credentials: { pixelId: "123", accessToken: "tok_abc" },
  validated: true,
  enabledEvents: ["revenue.RENEWAL"],
  eventMapping: {},
  actionSource: "app",
  testEventCode: "",
};

const EXISTING_CONNECTION: IntegrationConnectionRow = {
  id: "c1",
  providerId: "META_CAPI",
  displayName: "Meta Conversions API",
  credentialsHint: "…abc",
  enabledEvents: ["revenue.RENEWAL"],
  eventMapping: {},
  actionSource: "app",
  testEventCode: null,
  isEnabled: false,
  lastValidatedAt: null,
  lastError: null,
  lastBackfillAt: null,
  createdAt: "2026-05-01T00:00:00Z",
  updatedAt: "2026-05-01T00:00:00Z",
};

describe("StepActivate", () => {
  it("no existing connection — creates new integration then calls onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    const postSpy = vi.fn();
    const patchSpy = vi.fn();

    server.use(
      http.post(
        "http://localhost:3000/dashboard/projects/p1/integrations",
        async ({ request }) => {
          const body = await request.json();
          postSpy(body);
          return HttpResponse.json({ data: { id: "new1" } });
        },
      ),
      http.patch(
        "http://localhost:3000/dashboard/projects/p1/integrations/new1",
        async ({ request }) => {
          const body = await request.json();
          patchSpy(body);
          return HttpResponse.json({
            data: { ...EXISTING_CONNECTION, id: "new1", isEnabled: true },
          });
        },
      ),
    );

    renderWithRouter(
      <StepActivate
        state={BASE_STATE}
        onChange={vi.fn()}
        onNext={vi.fn()}
        onBack={vi.fn()}
        onClose={onClose}
        existingConnection={null}
        providerId="META_CAPI"
        projectId="p1"
      />,
    );

    const activateBtn = await screen.findByRole("button", { name: /activate/i });
    await user.click(activateBtn);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(postSpy).toHaveBeenCalled();
    expect(patchSpy).toHaveBeenCalledWith(expect.objectContaining({ isEnabled: true }));
  });

  it("existing connection — PATCHes isEnabled=true with the expected body then calls onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const patchSpy = vi.fn();

    server.use(
      http.patch(
        "http://localhost:3000/dashboard/projects/p1/integrations/c1",
        async ({ request }) => {
          const body = await request.json();
          patchSpy(body);
          return HttpResponse.json({
            data: { ...EXISTING_CONNECTION, isEnabled: true },
          });
        },
      ),
    );

    renderWithRouter(
      <StepActivate
        state={BASE_STATE}
        onChange={vi.fn()}
        onNext={vi.fn()}
        onBack={vi.fn()}
        onClose={onClose}
        existingConnection={EXISTING_CONNECTION}
        providerId="META_CAPI"
        projectId="p1"
      />,
    );

    const activateBtn = await screen.findByRole("button", { name: /activate/i });
    await user.click(activateBtn);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(patchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        isEnabled: true,
        enabledEvents: ["revenue.RENEWAL"],
      }),
    );
  });
});
