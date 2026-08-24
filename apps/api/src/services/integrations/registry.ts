import type { FanoutTopic, IntegrationProvider, ProviderId } from "./types";
import { metaCapiProvider } from "./providers/meta-capi";
import { tiktokEventsProvider } from "./providers/tiktok-events";

// @ts-expect-error CUSTOM_WEBHOOK provider lands in Task 7
export const PROVIDERS: Record<ProviderId, IntegrationProvider> = {
  META_CAPI: metaCapiProvider,
  TIKTOK_EVENTS: tiktokEventsProvider,
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
