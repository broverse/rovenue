// =============================================================
// Public funnel runner — renders a published funnel as a web page.
//
// Reuses the funnel-builder's <PagePreview> for rendering (page
// types, theme, footer chrome) but drives navigation through the
// real /public/funnel-sessions/.../advance API so server-side
// branching rules apply (the JSON config from /public/funnels/:slug
// has next_rules / default_next stripped).
//
// Phase 1 scope: click-through. The CTA fires `advance` with no
// answer; default-next routing carries the user forward. Real
// input capture (text, choice, slider, etc.) lands in Phase 2.
// =============================================================

import { useEffect, useMemo, useState } from "react";
import { PaywallRenderer, type RendererOffering } from "@rovenue/paywall-renderer";
import type { BuilderConfig, PackageView } from "@rovenue/shared/paywall";
import { PagePreview } from "../components/funnel-builder/page-preview";
import {
  advanceSession,
  getPublishedFunnel,
  RunnerApiError,
  startSession,
  type AdvanceResponse,
  type HydratedFunnelOffering,
  type PublishedFunnelConfig,
  type ResolvedFunnelPrice,
} from "./runner-api";
import { PaymentStep, type FunnelPaymentOutcome } from "./payment-step";
import { writeFunnelTokenToClipboard } from "./clipboard";
import { type LocaleCode } from "@rovenue/shared/i18n";
import { useRunnerLocale } from "./use-runner-locale";

/** Maps the server-hydrated offering shape into the renderer's minimal contract. */
function toRunnerOffering(offering: HydratedFunnelOffering | null): RendererOffering | null {
  if (!offering) return null;
  return {
    identifier: offering.identifier,
    packages: offering.packages.map((p) => ({
      packageIdentifier: p.packageIdentifier,
      displayName: p.displayName,
      metadata: p.metadata,
      storeIds: p.storeIds,
    })),
  };
}

/**
 * How many minor units STRIPE scales `unit_amount` by — which is not
 * always how the currency is written.
 *
 * CLDR (what `Intl` exposes) describes presentation; Stripe defines the
 * scaling of `unit_amount`, and for two currencies they disagree. ISK
 * and UGX both became zero-decimal in ISO 4217, and Intl duly reports 0
 * fraction digits for each — but Stripe still requires them as
 * two-decimal values for backwards compatibility: "to charge 5 ISK,
 * provide an `amount` value of `500`", and the same sentence verbatim
 * for UGX (https://docs.stripe.com/currencies — Special cases). An
 * Intl-derived divisor would render that 5 ISK charge as "ISK 500":
 * displayed price a hundred times the money actually taken.
 *
 * HUF and TWD also have special-case rows, but those constrain PAYOUTS
 * only ("Stripe treats HUF as a zero-decimal currency for payouts, even
 * though you can charge two-decimal amounts") — as charge currencies
 * they are ordinary two-decimal, which the default already gives.
 *
 * Only the DIVISOR comes from this table. Intl still decides how the
 * divided number is written, which is why ISK 5 prints as "ISK 5".
 */
const STRIPE_ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
  // UGX is deliberately NOT here. Stripe lists it among the
  // zero-decimal currencies and then overrides itself in the
  // special-cases table; the override is the one that governs
  // `unit_amount`, so UGX falls through to the default of 2.
]);

const STRIPE_THREE_DECIMAL_CURRENCIES = new Set([
  "BHD",
  "JOD",
  "KWD",
  "OMR",
  "TND",
]);

export function stripeMinorUnitExponent(currency: string): number {
  const code = currency.toUpperCase();
  if (STRIPE_THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  if (STRIPE_ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  return 2;
}

/**
 * Renders a server-resolved amount, or null if it cannot be rendered.
 *
 * The NUMBER is Stripe's, read server-side and shipped verbatim — the
 * browser only chooses how to draw it, so what the page shows and what
 * the card is charged cannot drift.
 *
 * `Intl.NumberFormat` throws `RangeError` on a currency or locale it
 * doesn't accept, and this runs during render: unguarded, one bad
 * three-letter code would take the whole page down to the router's
 * error boundary. `locale` in particular reaches us through an
 * unvalidated cast of the published funnel's `locales`, so `"en_US"` in
 * someone's config is enough. Answering null degrades that one price
 * instead — the same outcome a package the server couldn't price
 * already has.
 */
export function formatAmount(
  unitAmount: number,
  currency: string,
  locale: string,
): string | null {
  const amount = unitAmount / 10 ** stripeMinorUnitExponent(currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount);
  } catch {
    return null;
  }
}

/**
 * Builds the `{{price}}` / `{{period}}` substitution map the renderer
 * needs, from the prices the server resolved for THIS paywall. A
 * package the server could not price is simply absent — the renderer
 * then leaves its placeholders verbatim rather than inventing a number.
 */
export function toPriceView(
  offering: HydratedFunnelOffering | null,
  prices: Record<string, ResolvedFunnelPrice> | undefined,
  locale: string,
): Record<string, PackageView> | undefined {
  if (!prices || Object.keys(prices).length === 0) return undefined;
  const names = new Map(
    (offering?.packages ?? []).map((p) => [p.packageIdentifier, p.displayName]),
  );
  const out: Record<string, PackageView> = {};
  for (const [identifier, price] of Object.entries(prices)) {
    const amount = formatAmount(price.unitAmount, price.currency, locale);
    // Unformattable: leave the package out entirely rather than show a
    // half-built view. The renderer keeps its placeholders verbatim.
    if (amount === null) continue;
    const period = !price.interval
      ? ""
      : price.intervalCount && price.intervalCount > 1
        ? `${price.intervalCount} ${price.interval}s`
        : price.interval;
    out[identifier] = {
      packageName: names.get(identifier) ?? identifier,
      price: amount,
      pricePerPeriod: period ? `${amount}/${period}` : amount,
      period,
    };
  }
  return out;
}

type Status =
  | { kind: "loading" }
  | { kind: "error"; message: string; code?: string }
  | { kind: "ready" }
  | { kind: "done"; reason: "end" }
  // The whole outcome is kept, not just a flag: the success screen has
  // to render the deep link the /confirm response carried and write the
  // token to the clipboard from that click.
  | { kind: "done"; reason: "paywall_paid"; outcome: FunnelPaymentOutcome }
  | { kind: "paywall_pending"; pageId: string }
  // The buyer tapped purchase on a package that can't be charged — the
  // project disconnected Stripe, or the price didn't resolve. Shown
  // instead of opening a checkout that would only fail with a raw
  // server error the buyer should never read.
  | { kind: "unavailable" };

interface State {
  config: PublishedFunnelConfig;
  sessionId: string;
  currentPageId: string;
}

export function FunnelRunner({ slug }: { slug: string }) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  // Non-null while the buyer is on the in-page checkout for that package.
  const [payingPackage, setPayingPackage] = useState<string | null>(null);

  // Boot: fetch published config + open a session. Strict-mode safe via
  // the `cancelled` flag — if React mounts twice in dev, the second
  // session's state wins and the first is discarded.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const config = await getPublishedFunnel(slug);
        if (cancelled) return;
        const session = await startSession(slug);
        if (cancelled) return;
        setState({
          config,
          sessionId: session.session_id,
          currentPageId: session.first_page_id,
        });
        setStatus({ kind: "ready" });
      } catch (err) {
        if (cancelled) return;
        const code = err instanceof RunnerApiError ? err.code : undefined;
        const message = err instanceof Error ? err.message : String(err);
        setStatus({ kind: "error", code, message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const currentPage = useMemo(() => {
    if (!state) return null;
    return state.config.pages.find((p) => p.id === state.currentPageId) ?? null;
  }, [state]);

  const localeConfig = useMemo(
    () => ({
      defaultLocale:
        (state?.config as { defaultLocale?: string } | undefined)?.defaultLocale ?? "en",
      locales:
        ((state?.config as { locales?: string[] } | undefined)?.locales as LocaleCode[]) ?? ["en"],
    }),
    [state?.config],
  );
  const locale = useRunnerLocale(localeConfig);

  const handleAdvance = async () => {
    if (!state || !currentPage || busy) return;
    setBusy(true);
    try {
      const res: AdvanceResponse = await advanceSession(
        state.sessionId,
        currentPage.id,
      );
      if (res.next === "page") {
        setState({ ...state, currentPageId: res.page_id });
        return;
      }
      if (res.next === "paywall") {
        // Server told us the *next* logical step is paywall but didn't
        // give us a page id — surface a placeholder. In practice the
        // paywall is a real page in the config and `/advance` returns
        // its page_id directly, so this branch is rare.
        setStatus({ kind: "paywall_pending", pageId: currentPage.id });
        return;
      }
      setStatus({ kind: "done", reason: "end" });
    } catch (err) {
      const code = err instanceof RunnerApiError ? err.code : undefined;
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ kind: "error", code, message });
    } finally {
      setBusy(false);
    }
  };

  // The money has moved. Nothing is written to the clipboard here: by
  // this point we are seconds past the buyer's tap (confirmPayment plus
  // up to ~7s of /confirm retries), transient user activation is long
  // gone, and Safari would reject the write silently. The handoff moves
  // to the success screen's CTA, where the gesture is real.
  const handlePaid = (outcome: FunnelPaymentOutcome) => {
    setPayingPackage(null);
    setStatus({ kind: "done", reason: "paywall_paid", outcome });
  };

  if (status.kind === "loading") {
    return <CenteredMessage title="Loading…" />;
  }
  if (status.kind === "error") {
    return (
      <CenteredMessage
        title="Couldn't open this funnel"
        body={`${status.code ?? "ERROR"}: ${status.message}`}
      />
    );
  }
  if (status.kind === "unavailable") {
    return (
      <CenteredMessage
        title="This purchase isn't available right now"
        body="Please try again in a little while."
      />
    );
  }
  if (status.kind === "done") {
    return status.reason === "paywall_paid" ? (
      <PaidMessage outcome={status.outcome} />
    ) : (
      <CenteredMessage
        title="All done"
        body="You've reached the end of this funnel."
      />
    );
  }
  if (status.kind === "paywall_pending") {
    return (
      <CenteredMessage
        title="Paywall reached"
        body="The next step is the paywall, but the server didn't return a page id."
      />
    );
  }
  if (!state || !currentPage) {
    return <CenteredMessage title="No page" />;
  }

  // A paywall page MAY reference a project paywall built with the shared
  // paywall builder (`paywallId`). Only render it that way when the
  // server actually hydrated it into `paywalls` — a paywallId whose
  // paywall was deleted/cleared since publish falls back to the page's
  // legacy flat fields, unchanged from today.
  const builderPaywallId =
    currentPage.type === "paywall" && currentPage.paywallId
      ? currentPage.paywallId
      : undefined;
  const builderPaywall = builderPaywallId
    ? state.config.paywalls[builderPaywallId]
    : undefined;

  // Formatted from the server's own resolved prices, never from
  // anything this page works out for itself.
  const priceView = builderPaywall
    ? toPriceView(
        builderPaywall.offering,
        builderPaywallId ? state.config.prices?.[builderPaywallId] : undefined,
        locale,
      )
    : undefined;

  // Full viewport — no max-width, no centered column. The published
  // funnel fills the whole window on every breakpoint.
  return (
    <div
      className="h-[100dvh] w-screen overflow-hidden"
      style={{ background: state.config.theme.bg }}
    >
      {payingPackage ? (
        // In-page checkout. It replaces the paywall rather than opening
        // anywhere else: the whole point is that the buyer never leaves.
        <PaymentStep
          sessionId={state.sessionId}
          packageIdentifier={payingPackage}
          // The page whose paywall is being checked out. The server
          // resolves the package through this page, so what is charged
          // is what `priceView` below is showing.
          pageId={currentPage.id}
          priceLabel={priceView?.[payingPackage]?.price}
          onPaid={handlePaid}
          onCancel={() => setPayingPackage(null)}
        />
      ) : builderPaywall ? (
        <PaywallRenderer
          config={builderPaywall.builderConfig as BuilderConfig}
          offering={toRunnerOffering(builderPaywall.offering)}
          locale={locale}
          colorScheme="light"
          priceView={priceView}
          // The CTA opens the in-page checkout for the selected package —
          // but only when it can actually be charged. A project that
          // disconnected Stripe, or a package whose price didn't resolve,
          // would 503/400 with a raw server message the buyer should never
          // see; show an unavailable screen instead of opening checkout.
          // Restore is deliberately omitted (no onRestore) — hidden by
          // design in <PaywallRenderer> when the handler is absent.
          onPurchase={(packageIdentifier) => {
            const priced =
              builderPaywallId != null &&
              state.config.prices?.[builderPaywallId]?.[packageIdentifier] !=
                null;
            if (!state.config.charges_enabled || !priced) {
              setStatus({ kind: "unavailable" });
              return;
            }
            setPayingPackage(packageIdentifier);
          }}
        />
      ) : (
        <PagePreview
          page={currentPage}
          theme={state.config.theme}
          pages={state.config.pages}
          onAdvance={handleAdvance}
          chrome="full"
          locale={locale}
          defaultLocale={localeConfig.defaultLocale}
        />
      )}
    </div>
  );
}

/**
 * The screen a paying buyer lands on.
 *
 * The CTA is the point of it. `/confirm` hands back a deep link and a
 * universal link alongside the token, and this is the one place where a
 * click is a genuine user gesture — so the clipboard write (the
 * deferred handoff a fresh install reads on first launch) happens
 * inside that click rather than seconds earlier where the browser would
 * refuse it.
 *
 * No token means the Connect webhook completed the session first and
 * handed the plaintext out already. The money moved; the route back in
 * is a restore, and the copy says exactly that.
 */
function PaidMessage({ outcome }: { outcome: FunnelPaymentOutcome }) {
  const openUrl = outcome.deepLinkUrl ?? outcome.universalLinkUrl;
  const token = outcome.token;
  const handOff = () => {
    if (token) void writeFunnelTokenToClipboard(token);
  };

  return (
    <CenteredMessage
      title="You're all set"
      body={
        token
          ? "Payment received. Open the app to finish setting up your account."
          : "Payment received. Open the app and restore your purchase with the email you paid with."
      }
    >
      {token &&
        (openUrl ? (
          <a
            href={openUrl}
            onClick={handOff}
            className="mt-4 inline-block rounded-lg bg-zinc-900 px-5 py-3 text-[14px] font-semibold text-white no-underline"
          >
            Open the app
          </a>
        ) : (
          // No link configured for this project — the clipboard is the
          // only handoff left, and it still needs the gesture.
          <button
            type="button"
            onClick={handOff}
            className="mt-4 inline-block rounded-lg bg-zinc-900 px-5 py-3 text-[14px] font-semibold text-white"
          >
            Copy my access code
          </button>
        ))}
    </CenteredMessage>
  );
}

function CenteredMessage({
  title,
  body,
  children,
}: {
  title: string;
  body?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-white p-6 text-center text-rv-mute-700">
      <div className="max-w-md">
        {/* Explicitly dark: `text-foreground` is #fafafa, which on this
            white card renders the headline invisible. */}
        <h1 className="m-0 text-[20px] font-semibold text-zinc-900">{title}</h1>
        {body && <p className="mt-2 text-[13px] leading-relaxed">{body}</p>}
        {children}
      </div>
    </div>
  );
}
