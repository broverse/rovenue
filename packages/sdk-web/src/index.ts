import { createHttpClient, type HttpClient } from "./client";
import { createIdentity, type Identity } from "./identity";
import { createMemoryStorage, type SdkStorage } from "./storage";

export { RovenueApiError } from "./client";
export type { SdkStorage } from "./storage";

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
  const http = createHttpClient({
    apiUrl: options.apiUrl,
    publicKey: options.apiKey,
    identity,
    fetchImpl: options.fetchImpl,
  });

  return {
    http,
    identity,
    rovenueId: () => identity.rovenueId(),
    identify: (appUserId) => identity.identify(appUserId),
    logOut: () => identity.logOut(),
    async getEntitlements() {
      const data = await http.get<EntitlementsResponse>("/me/entitlements");
      return data.entitlements;
    },
    getOfferings: () => http.get("/offerings"),
    // An unknown placement returns an empty envelope rather than a 404, so
    // this resolves rather than throwing — the caller renders nothing.
    getPlacement: (identifier) => http.get(`/placements/${identifier}`),
    checkout: ({ idempotencyKey, ...body }) =>
      http.post<CheckoutResult>("/checkout", body, { idempotencyKey }),
  };
}
