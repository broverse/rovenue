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
import type { BuilderConfig } from "@rovenue/shared/paywall";
import { PagePreview } from "../components/funnel-builder/page-preview";
import {
  advanceSession,
  claimToken,
  getPublishedFunnel,
  RunnerApiError,
  startSession,
  type AdvanceResponse,
  type HydratedFunnelOffering,
  type PublishedFunnelConfig,
} from "./runner-api";
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

type Status =
  | { kind: "loading" }
  | { kind: "error"; message: string; code?: string }
  | { kind: "ready" }
  | { kind: "done"; reason: "end" | "paywall_paid" }
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
      // Paywall takes a different path — in dev_mode the stub claim-token
      // endpoint marks the session paid and issues a fake token, which is
      // enough for end-to-end testing without Stripe.
      if (currentPage.type === "paywall") {
        const res = await claimToken(state.sessionId);
        await writeFunnelTokenToClipboard(res.token);
        setStatus({ kind: "done", reason: "paywall_paid" });
        return;
      }
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
          status.reason === "paywall_paid"
            ? "Payment captured (dev stub). A claim token was issued for this session."
            : "You've reached the end of this funnel."
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
  const builderPaywall =
    currentPage.type === "paywall" && currentPage.paywallId
      ? state.config.paywalls[currentPage.paywallId]
      : undefined;

  // Full viewport — no max-width, no centered column. The published
  // funnel fills the whole window on every breakpoint.
  return (
    <div
      className="h-[100dvh] w-screen overflow-hidden"
      style={{ background: state.config.theme.bg }}
    >
      {builderPaywall ? (
        <PaywallRenderer
          config={builderPaywall.builderConfig as BuilderConfig}
          offering={toRunnerOffering(builderPaywall.offering)}
          locale={locale}
          colorScheme="light"
          priceView={undefined}
          // Same purchase/CTA path the legacy paywall page uses today —
          // handleAdvance's `currentPage.type === "paywall"` branch mints
          // a claim token via the (dev-mode-stub) /claim-token endpoint.
          // Restore is deliberately omitted (no onRestore) — hidden by
          // design in <PaywallRenderer> when the handler is absent.
          onPurchase={() => void handleAdvance()}
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
