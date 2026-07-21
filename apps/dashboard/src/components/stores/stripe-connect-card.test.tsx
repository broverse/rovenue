import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "../../../tests/render";
import { StripeConnectCard } from "./stripe-connect-card";

const useStripeConnection = vi.hoisted(() => vi.fn());
vi.mock("../../lib/hooks/useStripeConnection", () => ({
  useStripeConnection,
  useDisconnectStripe: () => ({ mutate: vi.fn(), isPending: false }),
}));

function arrange(data: unknown) {
  useStripeConnection.mockReturnValue({ data, isLoading: false });
  return renderWithRouter(<StripeConnectCard projectId="proj_1" />);
}

function arrangeError(refetch = vi.fn()) {
  useStripeConnection.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: true,
    isFetching: false,
    refetch,
  });
  return renderWithRouter(<StripeConnectCard projectId="proj_1" />);
}

const CONNECTED = {
  accountId: "acct_1A2B3C",
  livemode: true,
  chargesEnabled: true,
  payoutsEnabled: true,
  country: "TR",
  defaultCurrency: "try",
  connectedAt: "2026-07-21T00:00:00.000Z",
};

describe("StripeConnectCard", () => {
  // renderWithRouter's initial route match resolves asynchronously (see
  // app-card.test.tsx), so every assertion waits for the card to mount.
  it("explains the deployment is unconfigured and offers no connect action", async () => {
    arrange({ platformConfigured: false, testModeAvailable: false, connection: null });
    await waitFor(() => {
      expect(screen.getByTestId("stripe-platform-unconfigured")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /connect/i })).toBeNull();
  });

  it("offers a connect action when no account is linked", async () => {
    arrange({ platformConfigured: true, testModeAvailable: true, connection: null });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /connect/i })).toBeInTheDocument();
    });
    expect(screen.queryByText(/acct_/)).toBeNull();
  });

  it("hides the test-mode option when the platform has no test client id", async () => {
    arrange({ platformConfigured: true, testModeAvailable: false, connection: null });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /connect/i })).toBeInTheDocument();
    });
    expect(screen.queryByTestId("stripe-connect-test-mode")).toBeNull();
  });

  it("shows the account, a live badge and a disconnect action when connected", async () => {
    arrange({ platformConfigured: true, testModeAvailable: true, connection: CONNECTED });
    await waitFor(() => {
      expect(screen.getByText("acct_1A2B3C")).toBeInTheDocument();
    });
    expect(screen.getByTestId("stripe-livemode-badge")).toHaveTextContent(/live/i);
    expect(screen.getByRole("button", { name: /disconnect/i })).toBeInTheDocument();
  });

  it("warns that verification is pending when charges are not yet enabled", async () => {
    arrange({
      platformConfigured: true,
      testModeAvailable: true,
      connection: { ...CONNECTED, chargesEnabled: false },
    });
    await waitFor(() => {
      expect(screen.getByTestId("stripe-verification-pending")).toBeInTheDocument();
    });
  });

  it("surfaces a failed status lookup instead of spinning forever", async () => {
    // Without its own branch the `!data` guard renders the same
    // title-only skeleton as loading, so a transient API failure looks
    // identical to "still loading" and offers no way out.
    const refetch = vi.fn();
    arrangeError(refetch);
    await waitFor(() => {
      expect(screen.getByTestId("stripe-connection-error")).toBeInTheDocument();
    });
    const retry = screen.getByRole("button", { name: /retry/i });
    await userEvent.click(retry);
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
