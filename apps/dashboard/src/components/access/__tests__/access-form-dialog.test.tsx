import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi } from "vitest";
import { AccessFormDialog } from "../access-form-dialog";
// initialise i18n so useTranslation() returns real strings in jsdom
import "../../../i18n/config";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("AccessFormDialog", () => {
  it("requires a slug-style identifier", async () => {
    const onSave = vi.fn();
    wrap(
      <AccessFormDialog
        open
        mode="create"
        projectId="p_1"
        onClose={() => undefined}
        onSave={onSave}
      />,
    );
    fireEvent.change(screen.getByLabelText(/identifier/i), {
      target: { value: "Has Spaces!" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/identifier must be slug-like/i),
      ).toBeInTheDocument();
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("submits a valid payload", async () => {
    const onSave = vi.fn();
    wrap(
      <AccessFormDialog
        open
        mode="create"
        projectId="p_1"
        onClose={() => undefined}
        onSave={onSave}
      />,
    );
    fireEvent.change(screen.getByLabelText(/identifier/i), {
      target: { value: "premium" },
    });
    fireEvent.change(screen.getByLabelText(/display name/i), {
      target: { value: "Premium" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        identifier: "premium",
        displayName: "Premium",
        description: null,
      });
    });
  });
});
