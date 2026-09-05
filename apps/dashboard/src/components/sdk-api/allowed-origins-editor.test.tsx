import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../i18n/config";
import { AllowedOriginsEditor } from "./allowed-origins-editor";

// This editor decides whose JavaScript may use a public API key inside a
// visitor's browser. The tests below check the two things that matter: that a
// bad entry never reaches the save call, and that the empty state explains
// what empty MEANS — a key with no origins is not "unconfigured", it is
// unusable from a browser, and the developer's next signal is an opaque CORS
// error that never mentions Rovenue.

function setup(origins: string[] = []) {
  const onChange = vi.fn().mockResolvedValue(undefined);
  render(<AllowedOriginsEditor origins={origins} onChange={onChange} />);
  return { onChange };
}

function type(value: string) {
  fireEvent.change(screen.getByLabelText(/add a browser origin/i), {
    target: { value },
  });
}

describe("AllowedOriginsEditor", () => {
  it("saves a normalised origin", async () => {
    const { onChange } = setup();
    type("https://app.example.com/");
    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(["https://app.example.com"]),
    );
  });

  it.each([
    ["https://*.example.com", "wildcard"],
    ["https://app.example.com/admin", "path"],
    ["app.example.com", "no scheme"],
    ["javascript:alert(1)", "javascript scheme"],
  ])("refuses %s (%s) without calling onChange", async (value) => {
    const { onChange } = setup();
    type(value);
    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("says what an empty list means, not that it is empty", () => {
    setup([]);
    expect(
      screen.getByText(/cannot be used from a web page/i),
    ).toBeTruthy();
  });

  it("removes an origin", async () => {
    const { onChange } = setup([
      "https://a.example.com",
      "https://b.example.com",
    ]);
    fireEvent.click(
      screen.getByLabelText(/remove https:\/\/a\.example\.com/i),
    );
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(["https://b.example.com"]),
    );
  });

  it("does not add a duplicate", async () => {
    const { onChange } = setup(["https://app.example.com"]);
    type("https://app.example.com/");
    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    await waitFor(() => expect(onChange).not.toHaveBeenCalled());
  });

  it("surfaces a save failure instead of silently dropping it", async () => {
    const onChange = vi.fn().mockRejectedValue(new Error("nope"));
    render(<AllowedOriginsEditor origins={[]} onChange={onChange} />);
    type("https://app.example.com");
    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
