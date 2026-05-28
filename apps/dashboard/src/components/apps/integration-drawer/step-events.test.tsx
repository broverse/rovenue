import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "../../../../tests/render";
import { StepEvents } from "./step-events";
import type { DrawerState } from "./integration-drawer";

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
});
