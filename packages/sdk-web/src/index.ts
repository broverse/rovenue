import { createHttpClient, RovenueApiError, type HttpClient } from "./client";
import { createIdentity, type Identity } from "./identity";
import { createMemoryStorage, type SdkStorage } from "./storage";
import { createEntitlementCache, type CachedEntitlements } from "./cache";
import { createEventQueue, type TrackInput } from "./events";

export { RovenueApiError } from "./client";
export { createStorage, createMemoryStorage } from "./storage";
export type { SdkStorage } from "./storage";
export type { CachedEntitlements } from "./cache";
export type { TrackInput, QueuedEvent } from "./events";

// =============================================================
// @rovenue/web-sdk
// =============================================================
//
// Nothing in this module touches `window`, `document` or `localStorage` at
// import time. A server-rendered app imports and constructs the SDK during
// SSR, where none of those exist, and a module-scope access would throw
// before any consumer could guard it.

export interface RovenueOptions {
  /** The project's PUBLIC api key. Visible in the browser by design. */
  apiKey: string;
  /** Base URL of the Rovenue API, without a trailing path. */
  apiUrl: string;
  /** Injected for tests and for hosts that wrap fetch. */
  fetchImpl?: typeof fetch;
  /** Injected by the browser build; defaults to memory. */
  storage?: SdkStorage;
}

export interface EntitlementsResponse {
  entitlements: Record<string, unknown>;
}

export interface CheckoutResult {
  sessionId: string;
  url: string;
}

export interface Rovenue {
  /** The wire identity for this browser. */
  rovenueId(): string;
  /** Client-local. Merging subscribers is a server-side, secret-key operation. */
  identify(appUserId: string): void;
  logOut(): void;
  getEntitlements(): Promise<Record<string, unknown>>;
  /**
   * Last-known entitlements, or null if nothing has been fetched yet.
   *
   * Synchronous and network-free, so a first paint can render the truth the
   * server gave last time instead of a flash of the paywall a subscriber has
   * already paid to remove. It is a cache, never an authorization decision:
   * the storage behind it is viewer-editable.
   */
  getCachedEntitlements(): Record<string, unknown> | null;
  /** The cache entry with its timestamp, for callers that need staleness. */
  getCachedEntitlementsEntry(): CachedEntitlements | null;
  /**
   * Queues an event for at-least-once delivery.
   *
   * Returns immediately: the event is persisted and sent by the queue, which
   * retries across page loads and flushes when the tab is hidden or closing.
   */
  track(input: TrackInput): void;
  /** Attempts every queued event once. Called automatically on unload. */
  flushEvents(): Promise<void>;
  /**
   * Registers the unload listeners that flush queued events.
   *
   * Not called by configure(): configure() also runs during server
   * rendering, where there is nothing to listen to. The React provider calls
   * this in an effect; a non-React host calls it once after construction.
   */
  startEventQueue(): void;
  stopEventQueue(): void;
  getOfferings(): Promise<unknown>;
  getPlacement(identifier: string): Promise<unknown>;
  /**
   * Starts a Stripe Checkout and returns the URL to send the browser to.
   *
   * The caller names a package, never a price: the amount is resolved
   * server-side from the offering, so a page that lies about what something
   * costs changes nothing about what is charged.
   */
  checkout(input: {
    offeringId: string;
    packageIdentifier: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey?: string;
  }): Promise<CheckoutResult>;
  /** Escape hatch for endpoints without a typed wrapper yet. */
  readonly http: HttpClient;
  readonly identity: Identity;
}

export function configure(options: RovenueOptions): Rovenue {
  if (!options.apiKey) throw new Error("[rovenue] configure() needs an apiKey");
  if (!options.apiUrl) throw new Error("[rovenue] configure() needs an apiUrl");

  const storage = options.storage ?? createMemoryStorage();
  const identity = createIdentity(storage);
  const cache = createEntitlementCache(storage);
  const http = createHttpClient({
    apiUrl: options.apiUrl,
    publicKey: options.apiKey,
    identity,
    fetchImpl: options.fetchImpl,
  });
  const events = createEventQueue({
    storage,
    post: async (event) => {
      try {
        await http.post("/events", event, { keepalive: true });
        return true;
      } catch (err) {
        // A 4xx means this event will never be accepted — a malformed
        // envelope, or a key that no longer exists. Retrying it forever
        // would block the queue behind it, so it is acknowledged (dropped)
        // rather than retained. Anything else is worth another attempt.
        return err instanceof RovenueApiError && err.status < 500;
      }
    },
  });


  return {
    http,
    identity,
    rovenueId: () => identity.rovenueId(),
    identify: (appUserId) => identity.identify(appUserId),
    logOut: () => {
      // The cache belongs to the previous identity. Leaving it would show the
      // next person the last one's entitlements.
      cache.clear();
      identity.logOut();
    },
    async getEntitlements() {
      try {
        const data = await http.get<EntitlementsResponse>("/me/entitlements");
        cache.write(data.entitlements);
        return data.entitlements;
      } catch (err) {
        // Serving the cache is right for a failure the app cannot fix and the
        // viewer will recover from — offline, DNS, a 5xx. It is WRONG for a
        // 4xx: a revoked key, a wrong project or a rejected origin is a
        // configuration error, and answering it from cache hides it for as
        // long as the cache survives, which is exactly when a developer most
        // needs to see it.
        //
        // The one 4xx that is not a misconfiguration is 429, where backing
        // off and showing last-known is the correct behaviour.
        const status = err instanceof RovenueApiError ? err.status : null;
        const serveFromCache =
          status === null || status >= 500 || status === 429;
        if (!serveFromCache) throw err;

        const cached = cache.read();
        if (cached) return cached.entitlements;
        throw err;
      }
    },
    track: (input) => events.track(input),
    flushEvents: () => events.flush(),
    startEventQueue: () => events.start(),
    stopEventQueue: () => events.stop(),
    getCachedEntitlements: () => cache.read()?.entitlements ?? null,
    getCachedEntitlementsEntry: () => cache.read(),
    getOfferings: () => http.get("/offerings"),
    // An unknown placement returns an empty envelope rather than a 404, so
    // this resolves rather than throwing — the caller renders nothing.
    getPlacement: (identifier) => http.get(`/placements/${identifier}`),
    checkout: ({ idempotencyKey, ...body }) =>
      http.post<CheckoutResult>("/checkout", body, { idempotencyKey }),
  };
}
