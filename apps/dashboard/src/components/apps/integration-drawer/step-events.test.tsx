import { describe, expect, it, vi } from "vitest";
import { ROVENUE_EVENT_KEYS } from "@rovenue/shared";
import { http, HttpResponse } from "msw";
import { useState } from "react";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../../tests/msw/server";
import { renderWithRouter } from "../../../../tests/render";
import { StepEvents } from "./step-events";
import type { DrawerState } from "./integration-drawer";
import type { IntegrationConnectionRow } from "../../../lib/hooks/useProjectIntegrations";

const BASE_STATE: DrawerState = {
  step: "events",
  credentials: {},
  validated: true,
  enabledEvents: [],
  eventMapping: {},
  actionSource: "app",
  testEventCode: "",
};

function Wrapper({ onChanged }: { onChanged: (s: DrawerState) => void }) {
  const [state, setState] = useState<DrawerState>(BASE_STATE);
  return (
    <StepEvents
      state={state}
      onChange={(next) => {
        setState(next);
        onChanged(next);
      }}
      onNext={vi.fn()}
      onBack={vi.fn()}
      existingConnection={null}
      providerId="META_CAPI"
      projectId="p1"
    />
  );
}

describe("StepEvents", () => {
  it("clicking an unchecked event calls onChange with the event appended", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();

    renderWithRouter(<Wrapper onChanged={onChanged} />);

    // Find the revenue.RENEWAL checkbox and click it
    const checkbox = await screen.findByRole("checkbox", {
      name: "revenue.RENEWAL",
    });
    expect((checkbox as HTMLInputElement).checked).toBe(false);

    await user.click(checkbox);

    expect(onChanged).toHaveBeenCalled();
    const lastState = onChanged.mock.calls[onChanged.mock.calls.length - 1][0] as DrawerState;
    expect(lastState.enabledEvents).toContain("revenue.RENEWAL");
  });

  it("offers every ROVENUE_EVENT_KEYS entry for CUSTOM_WEBHOOK and hides Back", async () => {
    renderWithRouter(
      <StepEvents
        state={BASE_STATE}
        onChange={vi.fn()}
        onNext={vi.fn()}
        onBack={vi.fn()}
        existingConnection={null}
        providerId="CUSTOM_WEBHOOK"
        projectId="p1"
      />,
    );

    // A webhook-only event key (not in the ad-providers' 8-key catalog).
    expect(await screen.findByRole("checkbox", { name: "paywall.view" })).toBeTruthy();
    // Pinned to the constant, not a literal: this asserted 17 and had to be
    // hand-edited every time a public event key was added, which is the
    // same brittleness the provider tests carried.
    expect(screen.getAllByRole("checkbox")).toHaveLength(
      ROVENUE_EVENT_KEYS.length,
    );
    expect(screen.queryByRole("button", { name: /^back$/i })).toBeNull();
  });

  const EXISTING_WEBHOOK: IntegrationConnectionRow = {
    id: "wh1",
    providerId: "CUSTOM_WEBHOOK",
    displayName: "api.example.com",
    credentialsHint: "api.example.com · …abcd",
    enabledEvents: ["revenue.INITIAL"],
    eventMapping: {},
    actionSource: "app",
    testEventCode: null,
    isEnabled: true,
    lastValidatedAt: null,
    lastError: null,
    lastBackfillAt: null,
    createdAt: "2026-08-24T00:00:00Z",
    updatedAt: "2026-08-24T00:00:00Z",
  };

  it("reveals and rotates the webhook signing secret for an existing connection", async () => {
    const user = userEvent.setup();

    server.use(
      http.get(
        "http://localhost:3000/dashboard/projects/p1/integrations/wh1/secret",
        () => HttpResponse.json({ data: { secret: "whsec_revealed1234" } }),
      ),
      http.post(
        "http://localhost:3000/dashboard/projects/p1/integrations/wh1/rotate-secret",
        () => HttpResponse.json({ data: { secret: "whsec_rotatedABCD" } }),
      ),
    );

    renderWithRouter(
      <StepEvents
        state={{ ...BASE_STATE, enabledEvents: ["revenue.INITIAL"] }}
        onChange={vi.fn()}
        onNext={vi.fn()}
        onBack={vi.fn()}
        existingConnection={EXISTING_WEBHOOK}
        providerId="CUSTOM_WEBHOOK"
        projectId="p1"
      />,
    );

    await user.click(await screen.findByRole("button", { name: /reveal secret/i }));
    expect(await screen.findByText("whsec_revealed1234")).toBeTruthy();
  });

  it("rotate shows the newly rotated secret with a 'won't be shown again' warning", async () => {
    const user = userEvent.setup();

    server.use(
      http.post(
        "http://localhost:3000/dashboard/projects/p1/integrations/wh1/rotate-secret",
        () => HttpResponse.json({ data: { secret: "whsec_rotatedABCD" } }),
      ),
    );

    renderWithRouter(
      <StepEvents
        state={{ ...BASE_STATE, enabledEvents: ["revenue.INITIAL"] }}
        onChange={vi.fn()}
        onNext={vi.fn()}
        onBack={vi.fn()}
        existingConnection={EXISTING_WEBHOOK}
        providerId="CUSTOM_WEBHOOK"
        projectId="p1"
      />,
    );

    await user.click(await screen.findByRole("button", { name: /rotate secret/i }));

    expect(await screen.findByText("whsec_rotatedABCD")).toBeTruthy();
    expect(screen.getByText(/won't be shown again/i)).toBeTruthy();
  });
});
