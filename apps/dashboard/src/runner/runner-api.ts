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

export function getSessionState(sessionId: string): Promise<SessionState> {
  return request<SessionState>(
    `/public/funnel-sessions/${encodeURIComponent(sessionId)}/state`,
  );
}
