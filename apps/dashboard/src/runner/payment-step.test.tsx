import { describe, expect, it, beforeEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "../../tests/render";
import type * as RunnerApi from "./runner-api";

// ---------------------------------------------------------------
// Stripe is mocked wholesale: no network, no iframe, no real
// Elements. The mock keeps the SHAPE the component depends on —
// an <Elements> provider, the two Element components, and the
// useStripe/useElements hooks — so a change to how the component
// drives Stripe still shows up here.
// ---------------------------------------------------------------
const stripe = vi.hoisted(() => ({
  confirmPayment: vi.fn(),
  confirmSetup: vi.fn(),
}));
const loadStripe = vi.hoisted(() => vi.fn());
// Stands in for the ExpressCheckoutElement confirm event. The real one
// carries paymentFailed(), which is how the wallet sheet is dismissed.
const walletEvent = vi.hoisted(() => ({ paymentFailed: vi.fn() }));

vi.mock("@stripe/stripe-js", () => ({ loadStripe }));

vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="stripe-elements">{children}</div>
  ),
  PaymentElement: () => <div data-testid="payment-element" />,
  ExpressCheckoutElement: ({
    onConfirm,
  }: {
    onConfirm: (event: typeof walletEvent) => void;
  }) => (
    <button
      type="button"
      data-testid="express-checkout"
      onClick={() => onConfirm(walletEvent)}
    >
      Express checkout
    </button>
  ),
  useStripe: () => stripe,
  useElements: () => ({ mock: "elements" }),
}));

vi.mock("./runner-api", async (importActual) => {
  const actual = await importActual<typeof RunnerApi>();
  return {
    ...actual,
    createPaymentIntent: vi.fn(),
    confirmFunnelPayment: vi.fn(),
  };
});

import { PaymentStep } from "./payment-step";
import * as api from "./runner-api";
import { RunnerApiError } from "./runner-api";

const paymentIntent = {
  client_secret: "pi_1_secret_abc",
  mode: "payment" as const,
  publishable_key: "pk_test_123",
  stripe_account: "acct_123",
};

function renderStep(
  props: Partial<React.ComponentProps<typeof PaymentStep>> = {},
) {
  const onPaid = vi.fn();
  const onCancel = vi.fn();
  renderWithRouter(
    <PaymentStep
      sessionId="sess_1"
      packageIdentifier="monthly"
      pageId="page_paywall_1"
      onPaid={onPaid}
      onCancel={onCancel}
      // No waiting in tests; the production default backs off for real.
      confirmRetryDelaysMs={[0, 0, 0]}
      {...props}
    />,
  );
  return { onPaid, onCancel };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadStripe.mockResolvedValue({});
  vi.mocked(api.createPaymentIntent).mockResolvedValue(paymentIntent);
  vi.mocked(api.confirmFunnelPayment).mockResolvedValue({
    already_issued: false,
    token: "tok_live",
    deep_link_url: "myapp://onboarding-complete?token=tok_live",
    universal_link_url: null,
  });
  stripe.confirmPayment.mockResolvedValue({});
  stripe.confirmSetup.mockResolvedValue({});
});

describe("<PaymentStep>", () => {
  it("asks for an email before creating an intent when the funnel collected none", async () => {
    const user = userEvent.setup();
    renderStep();

    const field = await screen.findByLabelText(/email/i);
    expect(api.createPaymentIntent).not.toHaveBeenCalled();

    await user.type(field, "buyer@example.com");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() =>
      expect(api.createPaymentIntent).toHaveBeenCalledWith("sess_1", {
        package_identifier: "monthly",
        page_id: "page_paywall_1",
        email: "buyer@example.com",
      }),
    );
  });

  it("skips the email prompt and creates the intent straight away when the funnel already has one", async () => {
    renderStep({ email: "known@example.com" });

    await waitFor(() =>
      expect(api.createPaymentIntent).toHaveBeenCalledWith("sess_1", {
        package_identifier: "monthly",
        // The paywall page the checkout was opened from: it is what the
        // server resolves the package (and therefore the price) through.
        page_id: "page_paywall_1",
        email: "known@example.com",
      }),
    );
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
  });

  it("renders Express Checkout and the Payment Element once a client secret arrives", async () => {
    renderStep({ email: "known@example.com" });

    expect(await screen.findByTestId("payment-element")).toBeInTheDocument();
    expect(screen.getByTestId("express-checkout")).toBeInTheDocument();
    expect(loadStripe).toHaveBeenCalledWith("pk_test_123", {
      stripeAccount: "acct_123",
    });
  });

  it("keeps the buyer on the step and shows Stripe's own message when the card is declined", async () => {
    const user = userEvent.setup();
    stripe.confirmPayment.mockResolvedValue({
      error: { message: "Your card was declined." },
    });
    const { onPaid } = renderStep({ email: "known@example.com" });

    await user.click(await screen.findByRole("button", { name: /pay/i }));

    expect(await screen.findByText("Your card was declined.")).toBeInTheDocument();
    expect(api.confirmFunnelPayment).not.toHaveBeenCalled();
    expect(onPaid).not.toHaveBeenCalled();
    // Still on the payment step, able to try another card.
    expect(screen.getByTestId("payment-element")).toBeInTheDocument();
  });

  it("confirms without leaving the page and hands the token to onPaid", async () => {
    const user = userEvent.setup();
    const { onPaid } = renderStep({ email: "known@example.com" });

    await user.click(await screen.findByRole("button", { name: /pay/i }));

    await waitFor(() => expect(onPaid).toHaveBeenCalledTimes(1));
    expect(stripe.confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({ redirect: "if_required" }),
    );
    expect(api.confirmFunnelPayment).toHaveBeenCalledWith("sess_1");
    expect(onPaid).toHaveBeenCalledWith({
      alreadyIssued: false,
      token: "tok_live",
      deepLinkUrl: "myapp://onboarding-complete?token=tok_live",
      universalLinkUrl: null,
    });
  });

  it("routes the express-checkout wallet through the same confirmation", async () => {
    const user = userEvent.setup();
    const { onPaid } = renderStep({ email: "known@example.com" });

    await user.click(await screen.findByTestId("express-checkout"));

    await waitFor(() => expect(onPaid).toHaveBeenCalledTimes(1));
    expect(stripe.confirmPayment).toHaveBeenCalledTimes(1);
  });

  it("confirms a SETUP intent with confirmSetup when the package starts a trial", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createPaymentIntent).mockResolvedValue({
      ...paymentIntent,
      mode: "setup",
      client_secret: "seti_1_secret_abc",
    });
    const { onPaid } = renderStep({ email: "known@example.com" });

    await user.click(await screen.findByRole("button", { name: /start|pay/i }));

    await waitFor(() => expect(onPaid).toHaveBeenCalledTimes(1));
    expect(stripe.confirmSetup).toHaveBeenCalledWith(
      expect.objectContaining({ redirect: "if_required" }),
    );
    expect(stripe.confirmPayment).not.toHaveBeenCalled();
  });

  it("treats a 409 from /confirm as 'not settled yet' and retries before failing", async () => {
    const user = userEvent.setup();
    vi.mocked(api.confirmFunnelPayment)
      .mockRejectedValueOnce(
        new RunnerApiError("HTTP_ERROR", "Payment is not complete", 409),
      )
      .mockRejectedValueOnce(
        new RunnerApiError("HTTP_ERROR", "Payment is not complete", 409),
      )
      .mockResolvedValue({
        already_issued: false,
        token: "tok_late",
        deep_link_url: null,
        universal_link_url: null,
      });
    const { onPaid } = renderStep({ email: "known@example.com" });

    await user.click(await screen.findByRole("button", { name: /pay/i }));

    await waitFor(() => expect(onPaid).toHaveBeenCalledTimes(1));
    expect(api.confirmFunnelPayment).toHaveBeenCalledTimes(3);
    expect(onPaid).toHaveBeenCalledWith(
      expect.objectContaining({ token: "tok_late", alreadyIssued: false }),
    );
  });

  it("gives up with an error only after every 409 retry is spent", async () => {
    const user = userEvent.setup();
    vi.mocked(api.confirmFunnelPayment).mockRejectedValue(
      new RunnerApiError("HTTP_ERROR", "Payment is not complete", 409),
    );
    const { onPaid } = renderStep({ email: "known@example.com" });

    await user.click(await screen.findByRole("button", { name: /pay/i }));

    await waitFor(() => expect(api.confirmFunnelPayment).toHaveBeenCalledTimes(4));
    expect(onPaid).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /still confirming|not complete/i,
    );
  });

  it("treats already_issued as success — the money moved even though the token is gone", async () => {
    const user = userEvent.setup();
    vi.mocked(api.confirmFunnelPayment).mockResolvedValue({
      already_issued: true,
    });
    const { onPaid } = renderStep({ email: "known@example.com" });

    await user.click(await screen.findByRole("button", { name: /pay/i }));

    await waitFor(() => expect(onPaid).toHaveBeenCalledTimes(1));
    expect(onPaid).toHaveBeenCalledWith({
      alreadyIssued: true,
      token: null,
      deepLinkUrl: null,
      universalLinkUrl: null,
    });
  });

  it("never shows the buyer the JSON envelope some endpoints put in the message", async () => {
    // apps/api/src/routes/public/funnel-payment.ts smuggles a machine
    // code through the HTTPException message, and the error handler
    // passes it through verbatim.
    vi.mocked(api.createPaymentIntent).mockRejectedValue(
      new RunnerApiError(
        "HTTP_ERROR",
        JSON.stringify({ code: "STRIPE_NOT_CONNECTED" }),
        409,
      ),
    );
    renderStep({ email: "known@example.com" });

    const note = await screen.findByRole("alert");
    expect(note).toHaveTextContent(/can't take payments right now/i);
    expect(note.textContent).not.toContain("STRIPE_NOT_CONNECTED");
    expect(note.textContent).not.toContain("{");
  });

  it("falls back to the server's own prose for a JSON envelope whose code it doesn't know", async () => {
    vi.mocked(api.createPaymentIntent).mockRejectedValue(
      new RunnerApiError(
        "HTTP_ERROR",
        JSON.stringify({ code: "SOMETHING_NEW", message: "Try again later" }),
        503,
      ),
    );
    renderStep({ email: "known@example.com" });

    const note = await screen.findByRole("alert");
    expect(note).toHaveTextContent("Try again later");
    expect(note.textContent).not.toContain("{");
  });

  it("sends someone whose confirmation never settled to restore-by-email, not to a refresh", async () => {
    const user = userEvent.setup();
    vi.mocked(api.confirmFunnelPayment).mockRejectedValue(
      new RunnerApiError("HTTP_ERROR", "Payment is not complete", 409),
    );
    renderStep({ email: "known@example.com" });

    await user.click(await screen.findByRole("button", { name: /pay/i }));

    const note = await screen.findByRole("alert");
    await waitFor(() =>
      expect(note).toHaveTextContent(/restore your purchase with the email/i),
    );
    // Refreshing mints a NEW session, so it cannot recover this one.
    expect(note.textContent).not.toMatch(/refresh/i);
  });

  it("tells the wallet sheet to close when the payment is declined", async () => {
    const user = userEvent.setup();
    stripe.confirmPayment.mockResolvedValue({
      error: { message: "Your card was declined." },
    });
    renderStep({ email: "known@example.com" });

    await user.click(await screen.findByTestId("express-checkout"));

    await waitFor(() => expect(walletEvent.paymentFailed).toHaveBeenCalledTimes(1));
    expect(walletEvent.paymentFailed).toHaveBeenCalledWith({ reason: "fail" });
    expect(await screen.findByText("Your card was declined.")).toBeInTheDocument();
  });

  it("leaves the wallet sheet alone when the payment goes through", async () => {
    const user = userEvent.setup();
    const { onPaid } = renderStep({ email: "known@example.com" });

    await user.click(await screen.findByTestId("express-checkout"));

    await waitFor(() => expect(onPaid).toHaveBeenCalledTimes(1));
    expect(walletEvent.paymentFailed).not.toHaveBeenCalled();
  });

  it("surfaces an intent-creation failure and lets the buyer back out", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createPaymentIntent).mockRejectedValue(
      new RunnerApiError("HTTP_ERROR", "Stripe Connect is not configured", 503),
    );
    const { onCancel } = renderStep({ email: "known@example.com" });

    expect(
      await screen.findByText("Stripe Connect is not configured"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /back/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
