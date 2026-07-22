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
 * Renders a server-resolved amount.
 *
 * The NUMBER is Stripe's, read server-side and shipped verbatim — the
 * browser only chooses how to draw it, so what the page shows and what
 * the card is charged cannot drift. Even the minor-unit divisor comes
 * from Intl's own currency data rather than a hardcoded 100: JPY has no
 * minor units, and dividing it by 100 would advertise a price a hundred
 * times too small.
 */
function formatAmount(unitAmount: number, currency: string, locale: string): string {
  const fmt = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
  });
  const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
  return fmt.format(unitAmount / 10 ** digits);
}

/**
 * Builds the `{{price}}` / `{{period}}` substitution map the renderer
 * needs, from the prices the server resolved for THIS paywall. A
 * package the server could not price is simply absent — the renderer
 * then leaves its placeholders verbatim rather than inventing a number.
 */
function toPriceView(
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
  // `tokenIssued: false` means the money moved but the plaintext claim
  // token had already been handed out (the Connect webhook completed
  // this session first). Still a success — just a different next step.
  | { kind: "done"; reason: "end" | "paywall_paid"; tokenIssued?: boolean }
  | { kind: "paywall_pending"; pageId: string };

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

  // The money has moved. The token — when there is one to hand out —
  // goes to the clipboard so a fresh install can pick it up without a
  // deep link (NativeLink-style deferred handoff).
  const handlePaid = async (outcome: FunnelPaymentOutcome) => {
    if (outcome.token) await writeFunnelTokenToClipboard(outcome.token);
    setPayingPackage(null);
    setStatus({
      kind: "done",
      reason: "paywall_paid",
      tokenIssued: outcome.token !== null,
    });
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
  if (status.kind === "done") {
    return (
      <CenteredMessage
        title={status.reason === "paywall_paid" ? "You're all set" : "All done"}
        body={
          status.reason !== "paywall_paid"
            ? "You've reached the end of this funnel."
            : status.tokenIssued
              ? "Payment received. Open the app to finish setting up your account."
              : "Payment received. Open the app and restore your purchase with the email you paid with."
        }
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
          priceLabel={priceView?.[payingPackage]?.price}
          onPaid={(outcome) => void handlePaid(outcome)}
          onCancel={() => setPayingPackage(null)}
        />
      ) : builderPaywall ? (
        <PaywallRenderer
          config={builderPaywall.builderConfig as BuilderConfig}
          offering={toRunnerOffering(builderPaywall.offering)}
          locale={locale}
          colorScheme="light"
          priceView={priceView}
          // The CTA opens the in-page checkout for the selected package.
          // Restore is deliberately omitted (no onRestore) — hidden by
          // design in <PaywallRenderer> when the handler is absent.
          onPurchase={(packageIdentifier) => setPayingPackage(packageIdentifier)}
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

function CenteredMessage({ title, body }: { title: string; body?: string }) {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-white p-6 text-center text-rv-mute-700">
      <div className="max-w-md">
        <h1 className="m-0 text-[20px] font-semibold text-foreground">{title}</h1>
        {body && <p className="mt-2 text-[13px] leading-relaxed">{body}</p>}
      </div>
    </div>
  );
}
