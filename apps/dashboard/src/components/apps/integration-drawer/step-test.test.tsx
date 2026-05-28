import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { useState } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../../tests/msw/server";
import { renderWithRouter } from "../../../../tests/render";
import { StepTest } from "./step-test";
import type { DrawerState } from "./integration-drawer";

const BASE_STATE: DrawerState = {
  step: "test",
  credentials: {},
  validated: true,
  enabledEvents: ["revenue.RENEWAL"],
  eventMapping: {},
  actionSource: "app",
  testEventCode: "TEST12345",
};

function Wrapper() {
  const [state, setState] = useState<DrawerState>(BASE_STATE);
  return (
    <StepTest
      state={state}
      onChange={setState}
      onNext={vi.fn()}
      onBack={vi.fn()}
      existingConnection={{ id: "c1" }}
      providerId="META_CAPI"
      projectId="p1"
    />
  );
}

describe("StepTest", () => {
  it("clicking 'Send test event' shows HTTP 200 and events_received in response body", async () => {
    const user = userEvent.setup();

    server.use(
      http.post(
        "http://localhost:3000/dashboard/projects/p1/integrations/c1/test-event",
        () =>
          HttpResponse.json({
            data: {
              ok: true,
              httpStatus: 200,
              responseBody: JSON.stringify({ events_received: 1 }),
            },
          }),
      ),
    );

    renderWithRouter(<Wrapper />);

    const sendBtn = await screen.findByRole("button", {
      name: /send test event/i,
    });
    await user.click(sendBtn);

    await waitFor(() =>
      expect(screen.queryByText(/HTTP 200/)).toBeTruthy(),
    );

    expect(screen.getByText(/events_received/)).toBeTruthy();
  });
});
