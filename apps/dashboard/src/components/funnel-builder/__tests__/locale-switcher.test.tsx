import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LocaleSwitcher } from "../locale-switcher";

describe("<LocaleSwitcher>", () => {
  const base = {
    defaultLocale: "en",
    locales: ["en", "tr"],
    editLocale: "en",
    onSelect: vi.fn(),
    onAdd: vi.fn(),
    onRemove: vi.fn(),
  };

  it("lists every locale and marks the default", () => {
    render(<LocaleSwitcher {...base} />);
    fireEvent.click(screen.getByRole("button", { name: /en/i }));
    expect(screen.getByText(/tr/i)).toBeInTheDocument();
    expect(screen.getByText(/default/i)).toBeInTheDocument();
  });

  it("calls onSelect when a non-edit locale is clicked", () => {
    const onSelect = vi.fn();
    render(<LocaleSwitcher {...base} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /en/i }));
    fireEvent.click(screen.getByText("tr"));
    expect(onSelect).toHaveBeenCalledWith("tr");
  });

  it("calls onAdd with a typed locale code", () => {
    const onAdd = vi.fn();
    render(<LocaleSwitcher {...base} onAdd={onAdd} />);
    fireEvent.click(screen.getByRole("button", { name: /en/i }));
    fireEvent.click(screen.getByRole("button", { name: /add language/i }));
    fireEvent.change(screen.getByPlaceholderText(/bcp47/i), { target: { value: "de" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(onAdd).toHaveBeenCalledWith("de");
  });

  it("disables remove on the default locale", () => {
    render(<LocaleSwitcher {...base} editLocale="en" />);
    fireEvent.click(screen.getByRole("button", { name: /en/i }));
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
  });

  it("calls onRemove for a non-default locale", () => {
    const onRemove = vi.fn();
    render(<LocaleSwitcher {...base} editLocale="tr" onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: /tr/i }));
    fireEvent.click(screen.getByRole("button", { name: /remove tr/i }));
    expect(onRemove).toHaveBeenCalledWith("tr");
  });
});
