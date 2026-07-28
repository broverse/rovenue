import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { NumberField, POSITIVE_NUMBER_FIELD_MIN } from "./fields";

// =============================================================
// NumberField — the schema floor.
//
// `lottie.speed` and `video.aspectRatio` are both `z.number().positive()`
// in the shared schema, so a field that writes `0` does not raise the
// intended warning: it makes the WHOLE builderConfig SCHEMA_INVALID, with an
// error naming the config rather than the field the author touched. These
// pin that a below-minimum entry can be typed (it is a prefix of every value
// under 1) but never committed.
// =============================================================

const LABEL = "Speed";

function renderField(props: {
  value?: number;
  min?: number;
  onChange: (v: number | undefined) => void;
}) {
  // `Field` renders its label as a sibling of the control rather than a
  // `for`-associated one, so the input is found structurally.
  const utils = render(
    <NumberField label={LABEL} value={props.value} onChange={props.onChange} min={props.min} />,
  );
  const input = utils.container.querySelector("input");
  if (!input) throw new Error("NumberField rendered no input");
  return { ...utils, input };
}

describe("NumberField without a minimum", () => {
  it("commits what was typed, and an emptied field as undefined", () => {
    const onChange = vi.fn();
    const { input } = renderField({ value: 2, onChange });
    expect(input.value).toBe("2");

    fireEvent.change(input, { target: { value: "3" } });
    expect(onChange).toHaveBeenLastCalledWith(3);

    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("commits zero, which is a legitimate value for a field with no floor", () => {
    const onChange = vi.fn();
    const { input } = renderField({ onChange });
    fireEvent.change(input, { target: { value: "0" } });
    expect(onChange).toHaveBeenLastCalledWith(0);
  });
});

describe("NumberField with a minimum", () => {
  const MIN = POSITIVE_NUMBER_FIELD_MIN;

  it("never commits a below-minimum entry", () => {
    const onChange = vi.fn();
    const { input } = renderField({ min: MIN, onChange });
    fireEvent.change(input, { target: { value: "0" } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("still lets a below-minimum PREFIX be typed on the way to a valid value", () => {
    // The reason the field keeps a draft at all: refuse to display "0" and
    // every value under 1 becomes untypeable, because "0" is how each of them
    // starts.
    const onChange = vi.fn();
    const { input } = renderField({ min: MIN, onChange });

    fireEvent.change(input, { target: { value: "0" } });
    expect(input.value).toBe("0");

    fireEvent.change(input, { target: { value: "0.5" } });
    expect(onChange).toHaveBeenLastCalledWith(0.5);
  });

  it("clamps to the minimum on blur when the entry never became valid", () => {
    // What the `min` attribute promises. Landing on the minimum (rather than
    // reverting) is also what keeps LOTTIE_SPEED_OUT_OF_RANGE reachable: the
    // floor is far below that advisory band, so the author still sees the
    // warning they were reaching for.
    const onChange = vi.fn();
    const { input } = renderField({ min: MIN, onChange });
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(MIN);
    expect(input.value).toBe(String(MIN));
  });

  it("leaves an emptied field empty on blur, rather than filling in the minimum", () => {
    // Absent is a meaningful authored state for both fields it guards — "the
    // source's own ratio" and "LOTTIE_DEFAULT_SPEED" — so clearing must not
    // be turned into a value.
    const onChange = vi.fn();
    const { input } = renderField({ value: 2, min: MIN, onChange });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(input.value).toBe("");
  });

  it("advertises the minimum to the browser as well", () => {
    const { input } = renderField({ min: MIN, onChange: vi.fn() });
    expect(input.min).toBe(String(MIN));
  });

  it("re-syncs when the committed value changes from outside the field", () => {
    // Another node selected, an undo, an AI edit: the draft must not keep
    // showing the previous node's number.
    const onChange = vi.fn();
    const { input, rerender } = renderField({ value: 2, min: MIN, onChange });
    fireEvent.change(input, { target: { value: "0" } });
    expect(input.value).toBe("0");

    rerender(<NumberField label={LABEL} value={4} onChange={onChange} min={MIN} />);
    expect(input.value).toBe("4");
  });
});
