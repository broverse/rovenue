import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PaywallRenderer,
  resolvePersistedFirstShownAt,
} from "@rovenue/paywall-renderer";
import {
  assignBucketWeb,
  selectVariant,
} from "@rovenue/shared/experiments/bucketing-web";
import { usePlacement, useRovenue } from "../react/index";

// =============================================================
// Paywall binding
// =============================================================
//
// This feeds `@rovenue/paywall-renderer` — the renderer the dashboard
// already uses — with SDK data. It is wiring, not a second implementation:
// a web-only renderer would be a fourth decoder of the same node tree and
// would drift from the three that exist.
//
// Three things this component owns that the renderer deliberately does not:
//
//   1. **Variant assignment.** When a placement resolves to an experiment,
//      the draw is client-side and deterministic, seeded on the experiment
//      key and the subscriber. The browser implementation hashes with
//      WebCrypto because the shared one uses `node:crypto`; both are checked
//      against the same cross-language vectors, so a user's variant does not
//      change when they open the web app instead of their phone.
//   2. **The countdown anchor.** The renderer is presentational and owns no
//      storage, so the host supplies when this paywall was first shown.
//      Without it a `durationSeconds` countdown restarts on every mount,
//      which is not a deadline and buyers notice.
//   3. **The view event**, recorded once per placement rather than once per
//      render.

export interface RovenuePaywallProps {
  placement: string;
  colorScheme?: "light" | "dark";
  locale?: string;
  /** Rendered while the placement is being fetched. */
  fallback?: React.ReactNode;
  /**
   * Where Stripe returns the browser after checkout. Both are validated
   * server-side against the project's verified domains, so a URL the
   * dashboard has not verified is refused rather than followed.
   */
  successUrl: string;
  cancelUrl: string;
  /** Called instead of starting a checkout, if the host wants to own it. */
  onPurchase?: (packageIdentifier: string) => void;
  onClose?: () => void;
}

interface ResolvedPaywall {
  id: string;
  identifier: string;
  builderConfig?: unknown;
  offering: unknown;
}

interface PlacementEnvelope {
  placement: { identifier: string; revision: number } | null;
  paywall: ResolvedPaywall | null;
  experiment: {
    id: string;
    key: string;
    variants: Array<{
      variantId: string;
      weight: number;
      paywall: ResolvedPaywall;
    }>;
  } | null;
}

export function RovenuePaywall({
  placement,
  colorScheme = "light",
  locale,
  fallback = null,
  successUrl,
  cancelUrl,
  onPurchase,
  onClose,
}: RovenuePaywallProps) {
  const rovenue = useRovenue();
  const { placement: envelope, isLoading } = usePlacement(placement);
  const data = envelope as PlacementEnvelope | null;

  const [variantId, setVariantId] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ResolvedPaywall | null>(null);
  const viewRecordedFor = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function resolve() {
      if (!data) return;
      if (data.experiment && data.experiment.variants.length > 0) {
        const bucket = await assignBucketWeb(
          rovenue.rovenueId(),
          data.experiment.key,
        );
        const variant = selectVariant(bucket, data.experiment.variants);
        if (cancelled) return;
        setVariantId(variant.variantId);
        setChosen(variant.paywall);
        // Immediately after the draw, as the native path does. A visitor
        // bucketed into an arm but missing from exposure_events still
        // contributes revenue while being absent from the denominator, which
        // biases every conversion rate and breaks the sample-ratio check.
        void rovenue.recordExposure({
          experimentId: data.experiment.id,
          variantId: variant.variantId,
          placementId: data.placement?.identifier,
        });
        return;
      }
      if (cancelled) return;
      setVariantId(null);
      setChosen(data.paywall);
    }

    void resolve();
    return () => {
      cancelled = true;
    };
  }, [data, rovenue]);

  // Recorded once per resolved paywall, not once per render. A view event
  // fired on every paint would make the paywall funnel's denominator
  // meaningless.
  useEffect(() => {
    if (!chosen || !data?.placement) return;
    const key = `${data.placement.identifier}:${chosen.id}:${variantId ?? ""}`;
    if (viewRecordedFor.current === key) return;
    viewRecordedFor.current = key;

    rovenue.track({
      eventType: "paywall_view",
      subscriberId: rovenue.rovenueId(),
      paywallContext: {
        paywallId: chosen.id,
        placementId: data.placement.identifier,
        placementRevision: data.placement.revision,
        ...(variantId ? { variantId, experimentKey: data.experiment?.key } : {}),
      },
    });
  }, [chosen, data, variantId, rovenue]);

  // The renderer knows which package was tapped and nothing else — it is
  // presentational. Turning that into a charge is this layer's job, and it
  // names the package rather than a price: the amount is resolved server-side
  // from the offering, so a tampered page changes nothing about what is
  // charged.
  const handlePurchase = useCallback(
    (packageIdentifier: string) => {
      if (onPurchase) {
        onPurchase(packageIdentifier);
        return;
      }
      const offeringId = (chosen?.offering as { id?: string } | null)?.id;
      if (!offeringId) {
        // A builder paywall with no offering cannot be bought from. Silently
        // doing nothing is better than throwing inside a tap handler, and the
        // condition is a project configuration gap the dashboard shows.
        return;
      }
      void rovenue
        .checkout({
          offeringId,
          packageIdentifier,
          successUrl,
          cancelUrl,
        })
        .then((session) => {
          globalThis.location.assign(session.url);
        })
        .catch(() => {
          // Swallowed deliberately: an unhandled rejection inside a tap
          // handler surfaces as a console error the buyer cannot act on. A
          // host that wants to show something passes its own onPurchase.
        });
    },
    [chosen, onPurchase, rovenue, successUrl, cancelUrl],
  );

  // The native SDKs enqueue a paywall_close alongside the view. Without it
  // the ClickHouse paywall funnel sees web views with no matching close, so
  // dismissal rate is structurally wrong for any project with web traffic.
  const handleClose = useCallback(() => {
    if (chosen && data?.placement) {
      rovenue.track({
        eventType: "paywall_close",
        subscriberId: rovenue.rovenueId(),
        paywallContext: {
          paywallId: chosen.id,
          placementId: data.placement.identifier,
          placementRevision: data.placement.revision,
          ...(variantId
            ? { variantId, experimentKey: data.experiment?.key }
            : {}),
        },
      });
    }
    onClose?.();
  }, [chosen, data, variantId, rovenue, onClose]);

  const firstShownAt = useMemo(() => {
    if (!chosen) return undefined;
    // Same key the native SDKs use, so a countdown a buyer started on one
    // surface does not restart on another.
    return resolvePersistedFirstShownAt(chosen.id);
  }, [chosen]);

  if (isLoading && !chosen) return <>{fallback}</>;

  // An unknown or retired placement returns an empty envelope rather than a
  // 404, and a paywall without a builder config is a remote-config-only one.
  // Both render nothing rather than throwing: a shipped app must not break
  // because a placement was retired.
  if (!chosen || chosen.builderConfig === undefined) return null;

  return (
    <PaywallRenderer
      platform="web"
      config={chosen.builderConfig as never}
      offering={chosen.offering as never}
      colorScheme={colorScheme}
      locale={locale}
      firstShownAt={firstShownAt}
      onPurchase={handlePurchase}
      onClose={handleClose}
    />
  );
}
