import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../runner-api", () => ({
  getPublishedFunnel: vi.fn(),
  startSession: vi.fn(),
  advanceSession: vi.fn(),
  claimToken: vi.fn(),
  getSessionState: vi.fn(),
  submitAnswer: vi.fn(),
  RunnerApiError: class RunnerApiError extends Error {},
}));

vi.mock("../clipboard", () => ({
  writeFunnelTokenToClipboard: vi.fn().mockResolvedValue(undefined),
}));

// PaymentStep is reduced to a probe so the email hand-off is observable
// without dragging Stripe into this file.
const paymentProps = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../payment-step", () => ({
  PaymentStep: (props: Record<string, unknown>) => {
    paymentProps.current = props;
    return <div data-testid="payment-step" />;
  },
}));

vi.mock("@rovenue/paywall-renderer", () => ({
  PaywallRenderer: ({ onPurchase }: { onPurchase: (id: string) => void }) => (
    <button type="button" onClick={() => onPurchase("monthly")}>
      Buy monthly
    </button>
  ),
  // The runner imports this by name to anchor `durationSeconds` countdowns;
  // the real localStorage-backed helper is covered in the renderer package.
  resolvePersistedFirstShownAt: () => new Date("2027-01-01T00:00:00.000Z"),
}));

import { FunnelRunner } from "../funnel-runner";
import * as api from "../runner-api";

const theme = {
  primary: "#000",
  accent: "#000",
  bg: "#fff",
  text: "#000",
  font: "system-ui",
  logoUrl: "",
  logoLetter: "",
  progressStyle: "solid" as const,
  progressActive: "",
  progressInactive: "rgba(0,0,0,0.1)",
  backIcon: "chevron" as const,
  radius: 10,
};

function configWith(pages: unknown[]) {
  return {
    id: "f1",
    slug: "demo",
    version_id: "v1",
    settings: {},
    defaultLocale: "en",
    locales: ["en"],
    theme,
    pages,
    paywalls: {
      pw1: {
        builderConfig: {},
        configFormatVersion: 1,
        offering: {
          identifier: "default",
          isDefault: true,
          metadata: null,
          packages: [{ packageIdentifier: "monthly", displayName: "Monthly" }],
        },
      },
    },
    charges_enabled: true,
    prices: {
      pw1: {
        monthly: {
          packageIdentifier: "monthly",
          priceId: "price_1",
          unitAmount: 900,
          currency: "usd",
          interval: "month",
          intervalCount: 1,
          trialDays: null,
        },
      },
    },
  };
}

const emailPage = {
  id: "pg_1",
  type: "email",
  question_id: "q_email",
  title: { en: "Your email" },
  cta: { en: "Continue" },
};

async function mount(pages: unknown[]) {
  vi.mocked(api.getPublishedFunnel).mockResolvedValue(
    configWith(pages) as never,
  );
  vi.mocked(api.startSession).mockResolvedValue({
    session_id: "sess_1",
    first_page_id: (pages[0] as { id: string }).id,
  } as never);
  render(<FunnelRunner slug="demo" />);
  await waitFor(() => expect(api.startSession).toHaveBeenCalled());
}

describe("FunnelRunner — answer capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    paymentProps.current = {};
    vi.mocked(api.advanceSession).mockResolvedValue({
      next: "end",
    } as never);
  });

  it("sends the answer WITH the advance, not in a separate call", async () => {
    const user = userEvent.setup();
    await mount([emailPage]);

    await user.type(await screen.findByRole("textbox"), "a@b.com");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() =>
      expect(api.advanceSession).toHaveBeenCalledWith("sess_1", "pg_1", {
        question_id: "q_email",
        answer: "a@b.com",
      }),
    );
    // The server writes the answer before it evaluates branching, which
    // is precisely so the client has no ordering to get wrong. A separate
    // /answers call would put that ordering back in the client's hands.
    expect(api.submitAnswer).not.toHaveBeenCalled();
  });

  it("disables the CTA on a required page until it is answered", async () => {
    const user = userEvent.setup();
    await mount([{ ...emailPage, required: true }]);

    const cta = await screen.findByRole("button", { name: /continue/i });
    expect(cta).toBeDisabled();

    await user.type(screen.getByRole("textbox"), "a@b.com");
    expect(screen.getByRole("button", { name: /continue/i })).toBeEnabled();
  });

  it("advances with no answer key when the page has no question_id", async () => {
    const user = userEvent.setup();
    // Same page TYPE as the happy path — only question_id differs — so
    // the assertion isolates that field rather than the page type.
    const { question_id: _omitted, ...noQuestionId } = emailPage;
    await mount([{ ...noQuestionId, id: "pg_noq" }]);

    await user.type(await screen.findByRole("textbox"), "a@b.com");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    // A page id is NOT substituted for a missing question id: a row keyed
    // that way could never match a branching rule.
    await waitFor(() =>
      expect(api.advanceSession).toHaveBeenCalledWith("sess_1", "pg_noq", undefined),
    );
  });

  it("hands the collected email to the payment step", async () => {
    const user = userEvent.setup();
    const paywallPage = { id: "pg_pw", type: "paywall", paywallId: "pw1" };
    await mount([emailPage, paywallPage]);

    await user.type(await screen.findByRole("textbox"), "a@b.com");
    vi.mocked(api.advanceSession).mockResolvedValue({
      next: "page",
      page_id: "pg_pw",
    } as never);
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    await user.click(screen.getByRole("button", { name: /buy monthly/i }));

    await waitFor(() => expect(paymentProps.current.email).toBe("a@b.com"));
  });
});
