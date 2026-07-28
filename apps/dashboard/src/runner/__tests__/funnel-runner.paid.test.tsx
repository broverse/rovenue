import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FunnelPaymentOutcome } from "../payment-step";

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

// The paywall itself is not under test here — only what happens after
// the money moves. Both the renderer and the checkout are reduced to a
// single button so the test can drive straight to the success screen.
const outcome = vi.hoisted(
  () => ({ current: null as unknown }) as { current: FunnelPaymentOutcome },
);

/** Captures what the runner hands the renderer, so the countdown anchor
 *  wiring is observable from the consumer side and not only in the
 *  renderer package's own unit test. */
const paywallProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const firstShownAnchorIds = vi.hoisted(() => ({ current: [] as Array<string | null | undefined> }));

vi.mock("@rovenue/paywall-renderer", () => ({
  PaywallRenderer: (props: { onPurchase: (id: string) => void }) => {
    paywallProps.current = props as unknown as Record<string, unknown>;
    return (
      <button type="button" onClick={() => props.onPurchase("monthly")}>
        Buy monthly
      </button>
    );
  },
  // The real localStorage-backed helper is exercised in the renderer
  // package's own suite; here it only has to exist and return an instant,
  // because the runner imports it by name. The argument IS recorded though —
  // which id the runner anchors on is a decision worth pinning (see the
  // funnel-scope test below).
  resolvePersistedFirstShownAt: (anchorId?: string | null) => {
    firstShownAnchorIds.current.push(anchorId);
    return new Date("2027-01-01T00:00:00.000Z");
  },
}));

vi.mock("../payment-step", () => ({
  PaymentStep: ({ onPaid }: { onPaid: (o: FunnelPaymentOutcome) => void }) => (
    <button type="button" onClick={() => onPaid(outcome.current)}>
      Pay
    </button>
  ),
}));

import { FunnelRunner } from "../funnel-runner";
import * as api from "../runner-api";
import { writeFunnelTokenToClipboard } from "../clipboard";

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

const config = {
  id: "f1",
  slug: "demo",
  version_id: "v1",
  settings: {},
  defaultLocale: "en",
  locales: ["en"],
  theme,
  pages: [{ id: "p1", type: "paywall", paywallId: "pw1" }],
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
  // The purchase CTA now only opens checkout when the project can charge
  // and the package has a resolved price — these tests exercise the paid
  // flow, so both are present.
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

async function payWith(o: FunnelPaymentOutcome) {
  const user = userEvent.setup();
  outcome.current = o;
  render(<FunnelRunner slug="demo" />);
  await user.click(await screen.findByRole("button", { name: /buy monthly/i }));
  await user.click(await screen.findByRole("button", { name: /^pay$/i }));
  await screen.findByText("You're all set");
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getPublishedFunnel).mockResolvedValue(config as never);
  vi.mocked(api.startSession).mockResolvedValue({
    session_id: "s1",
    first_page_id: "p1",
  } as never);
});

describe("FunnelRunner — the screen a paying buyer lands on", () => {
  it("renders the deep link /confirm returned as the CTA", async () => {
    await payWith({
      alreadyIssued: false,
      token: "tok_live",
      deepLinkUrl: "myapp://claim?token=tok_live",
      universalLinkUrl: "https://app.example.com/claim",
    });

    const cta = screen.getByRole("link", { name: /open the app/i });
    expect(cta).toHaveAttribute("href", "myapp://claim?token=tok_live");
  });

  it("writes the clipboard from the CTA click, where the user gesture is real", async () => {
    const user = await payWith({
      alreadyIssued: false,
      token: "tok_live",
      deepLinkUrl: "myapp://claim?token=tok_live",
      universalLinkUrl: null,
    });

    // Nothing written before the click: by then the page is seconds past
    // the buyer's tap and transient activation is gone.
    expect(writeFunnelTokenToClipboard).not.toHaveBeenCalled();

    const cta = screen.getByRole("link", { name: /open the app/i });
    // jsdom can't follow a custom scheme; the handler still runs.
    cta.addEventListener("click", (e) => e.preventDefault());
    await user.click(cta);
    await waitFor(() =>
      expect(writeFunnelTokenToClipboard).toHaveBeenCalledWith("tok_live"),
    );
  });

  it("falls back to a copy button when the project configured no links", async () => {
    const user = await payWith({
      alreadyIssued: false,
      token: "tok_live",
      deepLinkUrl: null,
      universalLinkUrl: null,
    });

    await user.click(screen.getByRole("button", { name: /copy my access/i }));
    await waitFor(() =>
      expect(writeFunnelTokenToClipboard).toHaveBeenCalledWith("tok_live"),
    );
  });

  it("sends the already-issued buyer to restore-by-email with no token CTA", async () => {
    await payWith({
      alreadyIssued: true,
      token: null,
      deepLinkUrl: null,
      universalLinkUrl: null,
    });

    expect(
      screen.getByText(/restore your purchase with the email you paid with/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(writeFunnelTokenToClipboard).not.toHaveBeenCalled();
  });

  it("draws the headline in a colour that is visible on the white card", async () => {
    await payWith({
      alreadyIssued: false,
      token: "tok_live",
      deepLinkUrl: null,
      universalLinkUrl: null,
    });

    // `text-foreground` is #fafafa — on bg-white the headline vanishes.
    const heading = screen.getByRole("heading", { name: "You're all set" });
    expect(heading.className).not.toMatch(/\btext-foreground\b/);
    expect(heading.className).toMatch(/\btext-zinc-900\b/);
  });

  it("hands the paywall a persisted first-shown anchor for durationSeconds countdowns", async () => {
    // Without this the anchor defaults to mount time, so a "offer ends in"
    // countdown restarts on every reload — a timer, not a deadline.
    render(<FunnelRunner slug="demo" />);
    await screen.findByRole("button", { name: /buy monthly/i });
    expect(paywallProps.current?.firstShownAt).toBeInstanceOf(Date);
  });

  it("anchors on a FUNNEL-SCOPED id, not on a bare paywall identifier", async () => {
    // The storage-key PREFIX is shared with the iOS and Android SDKs by
    // value, but what follows it is not the same kind of id: the SDKs use
    // `paywall.paywallIdentifier`, and a funnel-hydrated paywall has none —
    // the runner only has the funnel config's paywall key ("pw1" here). The
    // scope keeps the two id spaces from colliding inside one origin and
    // makes the stored key self-describing. Dropping the scope would silently
    // put a funnel database id where an SDK paywall identifier is expected.
    firstShownAnchorIds.current = [];
    render(<FunnelRunner slug="demo" />);
    await screen.findByRole("button", { name: /buy monthly/i });
    expect(firstShownAnchorIds.current).toContain("funnel:pw1");
    expect(firstShownAnchorIds.current).not.toContain("pw1");
  });

  it("shows an unavailable screen instead of checkout when charges are off", async () => {
    vi.mocked(api.getPublishedFunnel).mockResolvedValue({
      ...config,
      charges_enabled: false,
    } as never);
    const user = userEvent.setup();
    render(<FunnelRunner slug="demo" />);

    await user.click(await screen.findByRole("button", { name: /buy monthly/i }));

    await screen.findByText("This purchase isn't available right now");
    // Checkout never opened — no Pay button reached.
    expect(screen.queryByRole("button", { name: /^pay$/i })).toBeNull();
  });

  it("shows an unavailable screen when the package has no resolved price", async () => {
    vi.mocked(api.getPublishedFunnel).mockResolvedValue({
      ...config,
      prices: {},
    } as never);
    const user = userEvent.setup();
    render(<FunnelRunner slug="demo" />);

    await user.click(await screen.findByRole("button", { name: /buy monthly/i }));

    await screen.findByText("This purchase isn't available right now");
    expect(screen.queryByRole("button", { name: /^pay$/i })).toBeNull();
  });
});
