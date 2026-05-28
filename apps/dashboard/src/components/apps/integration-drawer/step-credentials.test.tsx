import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { useState } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../../tests/msw/server";
import { renderWithRouter } from "../../../../tests/render";
import { StepCredentials } from "./step-credentials";
import type { DrawerState } from "./integration-drawer";

const BASE_STATE: DrawerState = {
  step: "credentials",
  credentials: {},
  validated: false,
  enabledEvents: [],
  eventMapping: {},
  actionSource: "app",
  testEventCode: "",
};

/** Stateful wrapper so the controlled inputs reflect onChange calls */
function Wrapper({ onValidated }: { onValidated: (s: DrawerState) => void }) {
  const [state, setState] = useState<DrawerState>(BASE_STATE);
  return (
    <StepCredentials
      state={state}
      onChange={(next) => {
        setState(next);
        if (next.validated) onValidated(next);
      }}
      onNext={vi.fn()}
      onBack={vi.fn()}
      existingConnection={null}
      providerId="META_CAPI"
      projectId="p1"
    />
  );
}

describe("StepCredentials", () => {
  it("validates credentials, calls onChange with validated=true, shows token preview, then Next button becomes enabled", async () => {
    const user = userEvent.setup();
    const onValidated = vi.fn();

    server.use(
      http.post(
        "http://localhost:3000/dashboard/projects/p1/integrations/validate",
        () => HttpResponse.json({ data: { ok: true } }),
      ),
    );

    renderWithRouter(<Wrapper onValidated={onValidated} />);

    const idInput = await screen.findByLabelText(/pixel id/i);
    const tokenInput = await screen.findByLabelText(/access token/i);

    await user.type(idInput, "123456789");
    await user.type(tokenInput, "tok_abcd1234");

    const validateBtn = screen.getByRole("button", { name: /validate/i });
    await user.click(validateBtn);

    // Wait for onChange to be called with validated=true
    await waitFor(() => expect(onValidated).toHaveBeenCalled());

    const validatedState = onValidated.mock.calls[0][0] as DrawerState;
    expect(validatedState.validated).toBe(true);

    // Token preview should show last 4 chars of the token
    expect(await screen.findByText(/1234/)).toBeTruthy();

    // Next button should be enabled
    const nextBtn = screen.getByRole("button", { name: /next/i });
    expect((nextBtn as HTMLButtonElement).disabled).toBe(false);
  });
});
