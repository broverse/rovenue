import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RowListEditor } from "./row-list-editor";

// =============================================================
// RowListEditor — the generic add/remove/reorder list Task 3 wires
// per-row fields into for featureList/socialProof/timeline. Rows have no
// stable identity of their own (authors create/order/delete them), so
// these pin index-based add/remove/move/patch behaviour against a
// minimal `renderRow` that only exercises the `patch` callback.
// =============================================================

type Row = { labelKey: string };

function harness(initial: Row[]) {
  const onChange = vi.fn();
  render(
    <RowListEditor<Row>
      rows={initial}
      onChange={onChange}
      newRow={() => ({ labelKey: "" })}
      addLabel="Add row"
      renderRow={(row, i, patch) => (
        <input
          aria-label={`label-${i}`}
          value={row.labelKey}
          onChange={(e) => patch({ labelKey: e.target.value })}
        />
      )}
    />,
  );
  return onChange;
}

describe("RowListEditor", () => {
  it("adds a row using newRow", () => {
    const onChange = harness([{ labelKey: "a" }]);
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    expect(onChange).toHaveBeenCalledWith([{ labelKey: "a" }, { labelKey: "" }]);
  });

  it("removes the row at an index", () => {
    const onChange = harness([{ labelKey: "a" }, { labelKey: "b" }]);
    fireEvent.click(screen.getAllByRole("button", { name: /remove/i })[0]!);
    expect(onChange).toHaveBeenCalledWith([{ labelKey: "b" }]);
  });

  it("moves a row up, and cannot move the first row up", () => {
    const onChange = harness([{ labelKey: "a" }, { labelKey: "b" }]);
    fireEvent.click(screen.getAllByRole("button", { name: /move up/i })[1]!);
    expect(onChange).toHaveBeenCalledWith([{ labelKey: "b" }, { labelKey: "a" }]);
    expect(screen.getAllByRole("button", { name: /move up/i })[0]).toBeDisabled();
  });

  it("patches one row without disturbing its siblings", () => {
    const onChange = harness([{ labelKey: "a" }, { labelKey: "b" }]);
    fireEvent.change(screen.getByLabelText("label-1"), { target: { value: "bb" } });
    expect(onChange).toHaveBeenCalledWith([{ labelKey: "a" }, { labelKey: "bb" }]);
  });
});
