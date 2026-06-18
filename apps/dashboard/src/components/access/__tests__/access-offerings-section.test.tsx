import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi } from "vitest";
import { AccessOfferingsSection } from "../access-offerings-section";

vi.mock("../../../lib/hooks/useProjectOfferings", () => ({
  useProjectOfferings: (_p: string) => ({
    data: {
      offerings: [
        { id: "ofr_1", identifier: "default", isDefault: true, packages: [], metadata: {} },
      ],
    },
    isLoading: false,
  }),
}));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("AccessOfferingsSection", () => {
  it("lists offerings scoped to the current access", async () => {
    wrap(<AccessOfferingsSection projectId="p_1" accessId="acs_1" />);
    await waitFor(() => {
      expect(screen.getByText("default")).toBeInTheDocument();
    });
  });

  it("shows empty state when no offerings yet", () => {
    wrap(<AccessOfferingsSection projectId="p_1" accessId={null} />);
    expect(
      screen.getByText(/select an access to see its offerings/i),
    ).toBeInTheDocument();
  });
});
