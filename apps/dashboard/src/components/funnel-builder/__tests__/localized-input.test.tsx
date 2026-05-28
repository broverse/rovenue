import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LocalizedInput, LocalizedArrayInput } from "../localized-input";

describe("<LocalizedInput>", () => {
  it("shows the value for editLocale", () => {
    render(<LocalizedInput value={{ en: "Hi", tr: "Selam" }} editLocale="tr" defaultLocale="en" onChange={() => {}} />);
    expect(screen.getByRole("textbox")).toHaveValue("Selam");
  });

  it("only writes the editLocale key", () => {
    const onChange = vi.fn();
    render(<LocalizedInput value={{ en: "Hi", tr: "Selam" }} editLocale="tr" defaultLocale="en" onChange={onChange} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Merhaba" } });
    expect(onChange).toHaveBeenCalledWith({ en: "Hi", tr: "Merhaba" });
  });

  it("falls back to defaultLocale as greyed placeholder when editLocale is empty", () => {
    render(
      <LocalizedInput value={{ en: "Hi" }} editLocale="tr" defaultLocale="en" onChange={() => {}} />,
    );
    expect(screen.getByRole("textbox")).toHaveAttribute("placeholder", expect.stringMatching(/Hi/));
  });

  it("works on undefined value (treats as empty)", () => {
    const onChange = vi.fn();
    render(<LocalizedInput value={undefined} editLocale="en" defaultLocale="en" onChange={onChange} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Hi" } });
    expect(onChange).toHaveBeenCalledWith({ en: "Hi" });
  });
});

describe("<LocalizedArrayInput>", () => {
  it("renders rows for editLocale's array and writes back", () => {
    const onChange = vi.fn();
    render(
      <LocalizedArrayInput
        value={{ en: ["a", "b"], tr: ["x", "y"] }}
        editLocale="tr"
        defaultLocale="en"
        onChange={onChange}
      />,
    );
    const inputs = screen.getAllByRole("textbox");
    expect(inputs.map((i) => (i as HTMLInputElement).value)).toEqual(["x", "y"]);

    fireEvent.change(inputs[0], { target: { value: "X1" } });
    expect(onChange).toHaveBeenCalledWith({ en: ["a", "b"], tr: ["X1", "y"] });
  });
});
