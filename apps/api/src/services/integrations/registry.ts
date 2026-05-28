import type { IntegrationProvider, ProviderId } from "./types";
import { metaCapiProvider } from "./providers/meta-capi";
import { tiktokEventsProvider } from "./providers/tiktok-events";

export const PROVIDERS: Record<ProviderId, IntegrationProvider> = {
  META_CAPI: metaCapiProvider,
  TIKTOK_EVENTS: tiktokEventsProvider,
};

export function getProvider(id: ProviderId): IntegrationProvider {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`unknown provider: ${String(id)}`);
  return p;
}
