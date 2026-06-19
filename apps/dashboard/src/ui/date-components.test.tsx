import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Calendar } from "./calendar";
import { DateField } from "./date-field";
import { DatePicker } from "./date-picker";
import { DateRangePicker } from "./date-range-picker";

// These are smoke tests: the HeroUI date components compose ~10 nested parts
// each, so the real risk is a bad part name / missing required child that
// tsc won't catch but throws at render. Asserting the react-aria roles
// (spinbutton segments, grid) confirms the composition is valid and that the
// ISO<->DateValue bridge surfaces a value.

describe("DateField", () => {
  it("renders three editable segments for a value", () => {
    render(
      <DateField label="From" value="2026-06-19" onChange={() => {}} />,
    );
    // month / day / year segments are react-aria spinbuttons.
    expect(screen.getAllByRole("spinbutton")).toHaveLength(3);
    expect(screen.getByText("From")).toBeInTheDocument();
  });
});

describe("DatePicker", () => {
  it("renders a field plus a calendar-popover trigger", () => {
    render(<DatePicker value="2026-06-19" onChange={() => {}} />);
    expect(screen.getAllByRole("spinbutton")).toHaveLength(3);
    // The trigger button opens the calendar popover.
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("opens the calendar on trigger click and emits ISO on day select", async () => {
    const onChange = vi.fn();
    render(<DatePicker value="2026-06-19" onChange={onChange} />);

    // No calendar until the trigger is pressed.
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button"));

    const grid = await screen.findByRole("grid");
    await userEvent.click(within(grid).getByText("15"));
    expect(onChange).toHaveBeenCalledWith("2026-06-15");
  });

  it("opens an empty picker on the current year, not 1900", async () => {
    render(<DatePicker value={null} onChange={() => {}} />);
    await userEvent.click(screen.getByRole("button"));
    await screen.findByRole("grid");

    const currentYear = String(new Date().getFullYear());
    expect(screen.getAllByText(new RegExp(currentYear)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/1900/)).not.toBeInTheDocument();
  });
});

describe("DateRangePicker", () => {
  it("renders start and end fields (six segments) sharing one trigger", () => {
    render(
      <DateRangePicker
        value={{ from: "2026-06-01", to: "2026-06-19" }}
        onChange={() => {}}
      />,
    );
    expect(screen.getAllByRole("spinbutton")).toHaveLength(6);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });
});

describe("Calendar", () => {
  it("renders a month grid and emits an ISO string on day selection", async () => {
    const onChange = vi.fn();
    render(<Calendar value="2026-06-19" onChange={onChange} />);

    const grid = screen.getByRole("grid");
    expect(grid).toBeInTheDocument();

    // Pick a different, unambiguous day in the shown month.
    const cell = within(grid).getByText("15");
    await userEvent.click(cell);

    expect(onChange).toHaveBeenCalledWith("2026-06-15");
  });
});
