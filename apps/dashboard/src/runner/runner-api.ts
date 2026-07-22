// =============================================================
// Public funnel runtime API client (browser, no auth).
//
// Mirrors the routes mounted at apps/api/src/app.ts:106 under
// `/public/...`. Intentionally plain-fetch — the dashboard's
// authed `rpc` client bakes in `credentials: "include"` for the
// Better Auth cookie, which we don't want on the public runner.
//
// Credentials are intentionally NOT sent: the API's public CORS
// policy is `origin: "*"` (apps/api/src/routes/public/funnels.ts:96)
// and browsers reject `*` together with credentialed requests.
// The `rv_funnel_sid` cookie set by /sessions is convenience only —
// every endpoint reads the session id from the URL path, not the
// cookie — so dropping credentials costs us nothing.
// =============================================================

import type { Page, Theme } from "../components/funnel-builder/types";

const BASE_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:3000") as string;

export class RunnerApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "RunnerApiError";
  }
}

interface Envelope<T> {
  data?: T;
  error?: { code: string; message: string };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers,
  });
  const envelope = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!res.ok) {
    const code = envelope?.error?.code ?? `HTTP_${res.status}`;
    const message = envelope?.error?.message ?? res.statusText;
    throw new RunnerApiError(code, message, res.status);
  }
  if (!envelope || envelope.data === undefined) {
    throw new RunnerApiError("MALFORMED_RESPONSE", "Missing data envelope", res.status);
  }
  return envelope.data;
}

// Mirrors apps/api/src/lib/offering-hydration.ts's hydrateOffering() return
// shape — this is a browser-side client, so we keep it structurally loose
// rather than importing an API-only type.
export interface HydratedFunnelOffering {
  identifier: string;
  isDefault: boolean;
  packages: Array<{
    packageIdentifier: string;
    displayName: string;
    metadata?: unknown;
    storeIds?: Record<string, string>;
    [key: string]: unknown;
  }>;
  metadata: unknown;
}

export interface HydratedFunnelPaywall {
  builderConfig: unknown;
  configFormatVersion: number;
  offering: HydratedFunnelOffering | null;
}

export interface PublishedFunnelConfig {
  id: string;
  slug: string;
  version_id: string;
  // The server strips branching rules before sending — pages are the
  // funnel-builder Page shape minus next_rules / default_next.
  pages: Page[];
  theme: Theme;
  settings: Record<string, unknown>;
  // Builder paywalls referenced by `paywallId` on a paywall page, keyed by
  // that id. A paywallId present on a page but absent here means the
  // referenced paywall was deleted/cleared since publish — fall back to
  // the page's legacy flat fields.
  paywalls: Record<string, HydratedFunnelPaywall>;
  // Server-resolved Stripe prices, keyed paywallId -> packageIdentifier.
  // Served separately from `paywalls` so a Stripe outage degrades to "no
  // prices" rather than "no paywall" (apps/api/src/routes/public/
  // funnels.ts). A package missing here has no displayable price.
  prices: Record<string, Record<string, ResolvedFunnelPrice>>;
}

export interface SessionStartResponse {
  session_id: string;
  first_page_id: string;
}

export type AdvanceResponse =
  | { next: "page"; page_id: string }
  | { next: "paywall" }
  | { next: "end" };

export interface SessionState {
  current_page_id: string;
  state: "in_progress" | "paid" | "abandoned" | "completed";
  has_claim_token: boolean;
}

export interface ClaimTokenResponse {
  token: string;
  deep_link_url: string | null;
  universal_link_url: string | null;
}

/**
 * A price the SERVER read off Stripe (apps/api/src/services/stripe/
 * price-resolver.ts). The browser never derives an amount of its own —
 * the number shown and the number charged come from this one object.
 * A package whose price could not be read is absent from the map.
 */
export interface ResolvedFunnelPrice {
  packageIdentifier: string;
  priceId: string;
  /** Minor units, exactly as Stripe reports it. */
  unitAmount: number;
  /** Lowercase ISO-4217, as Stripe reports it. */
  currency: string;
  /** null for a one-time price. */
  interval: "day" | "week" | "month" | "year" | null;
  intervalCount: number | null;
  trialDays: number | null;
}

/**
 * What POST /funnel-sessions/:sid/payment-intent answers with.
 *
 * `mode` says which object the browser has to confirm: a trial package
 * creates a subscription whose first step is a SetupIntent (card on
 * file, nothing charged yet), everything else a PaymentIntent. The
 * client secret belongs to whichever one it is, so the two must not be
 * confirmed with the wrong call.
 */
export interface FunnelPaymentIntentResponse {
  client_secret: string;
  mode: "payment" | "setup";
  publishable_key: string;
  /** Connected account the Elements instance has to be scoped to. */
  stripe_account: string;
}

/**
 * What POST /funnel-sessions/:sid/confirm answers with.
 *
 * `already_issued: true` is a SUCCESS, not a failure: the Connect
 * webhook completed this session first and handed the plaintext token
 * to whoever asked before us. Only the hash is stored, so it cannot be
 * returned a second time — but the money moved either way.
 */
export type FunnelConfirmResponse =
  | { already_issued: false; token: string; deep_link_url: string | null; universal_link_url: string | null }
  | { already_issued: true };

export function getPublishedFunnel(slug: string): Promise<PublishedFunnelConfig> {
  return request<PublishedFunnelConfig>(`/public/funnels/${encodeURIComponent(slug)}`);
}

export function startSession(
  slug: string,
  body: { utm?: Record<string, string>; referrer?: string } = {},
): Promise<SessionStartResponse> {
  return request<SessionStartResponse>(
    `/public/funnels/${encodeURIComponent(slug)}/sessions`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function submitAnswer(
  sessionId: string,
  body: { page_id: string; question_id: string; answer: unknown },
): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    `/public/funnel-sessions/${encodeURIComponent(sessionId)}/answers`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function advanceSession(
  sessionId: string,
  fromPageId: string,
): Promise<AdvanceResponse> {
  return request<AdvanceResponse>(
    `/public/funnel-sessions/${encodeURIComponent(sessionId)}/advance`,
    { method: "POST", body: JSON.stringify({ from_page_id: fromPageId }) },
  );
}

export function claimToken(sessionId: string): Promise<ClaimTokenResponse> {
  return request<ClaimTokenResponse>(
    `/public/funnel-sessions/${encodeURIComponent(sessionId)}/claim-token`,
    { method: "POST" },
  );
}

export function createPaymentIntent(
  sessionId: string,
  body: { package_identifier: string; email: string },
): Promise<FunnelPaymentIntentResponse> {
  return request<FunnelPaymentIntentResponse>(
    `/public/funnel-sessions/${encodeURIComponent(sessionId)}/payment-intent`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/**
 * Settle the session against Stripe and mint the claim token.
 *
 * Answers 409 while the payment is not yet readable as settled — which
 * on a trial can be the moments right after the browser finished
 * confirming the card. Callers must treat that as "not yet" and retry;
 * see `settleFunnelPayment` in payment-step.tsx.
 */
export function confirmFunnelPayment(
  sessionId: string,
): Promise<FunnelConfirmResponse> {
  return request<FunnelConfirmResponse>(
    `/public/funnel-sessions/${encodeURIComponent(sessionId)}/confirm`,
    { method: "POST" },
  );
}

export function getSessionState(sessionId: string): Promise<SessionState> {
  return request<SessionState>(
    `/public/funnel-sessions/${encodeURIComponent(sessionId)}/state`,
  );
}
