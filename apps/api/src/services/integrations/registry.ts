import type { FanoutTopic, IntegrationProvider, ProviderId } from "./types";
import { metaCapiProvider } from "./providers/meta-capi";
import { tiktokEventsProvider } from "./providers/tiktok-events";
import { customWebhookProvider } from "./providers/custom-webhook";
import { amplitudeProvider } from "./providers/amplitude";
import { mixpanelProvider } from "./providers/mixpanel";
import { appsflyerProvider } from "./providers/appsflyer";
import { adjustProvider } from "./providers/adjust";
import { slackProvider } from "./providers/slack";
import { firebaseGa4Provider } from "./providers/firebase-ga4";
import { brazeProvider } from "./providers/braze";
import { onesignalProvider } from "./providers/onesignal";
import { iterableProvider } from "./providers/iterable";
import { airbridgeProvider } from "./providers/airbridge";
import { singularProvider } from "./providers/singular";

export const PROVIDERS: Record<ProviderId, IntegrationProvider> = {
  META_CAPI: metaCapiProvider,
  TIKTOK_EVENTS: tiktokEventsProvider,
  CUSTOM_WEBHOOK: customWebhookProvider,
  AMPLITUDE: amplitudeProvider,
  MIXPANEL: mixpanelProvider,
  APPSFLYER: appsflyerProvider,
  ADJUST: adjustProvider,
  SLACK: slackProvider,
  FIREBASE_GA4: firebaseGa4Provider,
  BRAZE: brazeProvider,
  ONESIGNAL: onesignalProvider,
  ITERABLE: iterableProvider,
  AIRBRIDGE: airbridgeProvider,
  SINGULAR: singularProvider,
};

export function getProvider(id: ProviderId): IntegrationProvider {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`unknown provider: ${String(id)}`);
  return p;
}

/**
 * All registered provider ids, as a non-empty tuple suitable for
 * `z.enum(providerIds())`. The DB no longer constrains provider ids
 * (migration 0104 made `provider_id` a plain text column) — this is the
 * only remaining guard against an unknown providerId reaching the route.
 */
export function providerIds(): [ProviderId, ...ProviderId[]] {
  const ids = Object.keys(PROVIDERS) as ProviderId[];
  return ids as [ProviderId, ...ProviderId[]];
}

/** Deduped union of every registered provider's `topics`. */
export function fanoutTopics(): FanoutTopic[] {
  const seen = new Set<FanoutTopic>();
  for (const provider of Object.values(PROVIDERS)) {
    for (const topic of provider.topics) {
      seen.add(topic);
    }
  }
  return Array.from(seen);
}
