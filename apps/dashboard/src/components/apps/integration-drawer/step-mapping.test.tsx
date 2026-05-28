import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "../../../../tests/render";
import { StepMapping } from "./step-mapping";
import type { DrawerState } from "./integration-drawer";

const BASE_STATE: DrawerState = {
  step: "mapping",
  credentials: {},
  validated: true,
  enabledEvents: ["revenue.RENEWAL"],
  eventMapping: {},
  actionSource: "app",
  testEventCode: "",
};

function Wrapper({ onChanged }: { onChanged: (s: DrawerState) => void }) {
  const [state, setState] = useState<DrawerState>(BASE_STATE);
  return (
    <StepMapping
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

describe("StepMapping", () => {
  it("clicking Advanced then typing into the renewal input calls onChange with the mapping override", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();

    renderWithRouter(<Wrapper onChanged={onChanged} />);

    // Click the accordion toggle
    const advancedBtn = await screen.findByRole("button", {
      name: /advanced: customize event names/i,
    });
    await user.click(advancedBtn);

    // Find the mapping input for revenue.RENEWAL
    const input = await screen.findByLabelText(/mapping for revenue\.RENEWAL/i);
    await user.type(input, "CustomPurchase");

    // Verify onChange was called with eventMapping containing the new name
    const allCalls = onChanged.mock.calls.map((c) => c[0] as DrawerState);
    const withMapping = allCalls.find(
      (s) => s.eventMapping["revenue.RENEWAL"]?.eventName === "CustomPurchase",
    );
    expect(withMapping?.eventMapping["revenue.RENEWAL"]?.eventName).toBe(
      "CustomPurchase",
    );
  });
});
