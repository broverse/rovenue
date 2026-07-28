import type { BuilderConfig, PaywallNode } from "@rovenue/shared/paywall";
import { ssrfSafeFetch } from "../../lib/ssrf-guard";
import { assertSaveValid } from "./validate-config";

// =============================================================
// App Store listing import (P8 §6.14): parse an apps.apple.com URL,
// read the PUBLIC iTunes lookup API through the SSRF-safe dispatcher
// (the codebase's first listing-metadata caller — every other Apple
// integration is StoreKit/ASC server APIs), and assemble a draft
// builder tree. The route RETURNS the tree; nothing here writes
// builderConfig — the dashboard applies it client-side (spec §2).
//
// Artwork/screenshot URLs are hot-linked to Apple's CDN by decision
// (spec §1.1): there is no asset pipeline, image nodes are URL-only,
// and the builder's normal image-URL editing is the recovery path if
// Apple rots a URL.
// =============================================================

export const IMPORT_MAX_SCREENSHOTS = 3;
export const IMPORT_MAX_DESCRIPTION_CHARS = 280;

const ITUNES_LOOKUP_BASE = "https://itunes.apple.com/lookup";
const DEFAULT_COUNTRY = "us";
/** The CTA copy an import seeds — plain English; the author edits it like any localization value. */
const IMPORT_CTA_DEFAULT = "Continue";
const ELLIPSIS = "…";

export class AppStoreLookupError extends Error {
  constructor(public readonly code: "APP_STORE_LOOKUP_FAILED" | "APP_NOT_FOUND") {
    super(code);
    this.name = "AppStoreLookupError";
  }
}

export interface AppStoreListing {
  name: string;
  description: string;
  iconUrl: string;
  screenshotUrls: string[];
  artistName: string;
}

/**
 * `https://apps.apple.com/{country?}/app/{slug}/id{digits}` → appId +
 * country (path country segment, else "us"). Anything else — other hosts,
 * missing id segment, non-URLs — is null; the route turns that into a 400.
 * Mirrors the funnel settings' host-pinning precedent (settings-normalize).
 */
export function parseAppStoreUrl(url: string): { appId: string; country: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "apps.apple.com") return null;
  const idMatch = parsed.pathname.match(/\/id(\d+)(?:\/|$)/);
  if (!idMatch) return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  const country = segments[0] && /^[a-z]{2}$/i.test(segments[0]) ? segments[0].toLowerCase() : DEFAULT_COUNTRY;
  return { appId: idMatch[1]!, country };
}

interface LookupResult {
  trackName?: string;
  description?: string;
  artworkUrl512?: string;
  artworkUrl100?: string;
  screenshotUrls?: string[];
  artistName?: string;
}

/**
 * One GET against the public iTunes lookup API. Default transport is
 * `ssrfSafeFetch` — the URL is built from validated parts, but the
 * dispatcher also pins redirects/DNS the way every outbound call here does.
 */
export async function fetchAppStoreListing(
  input: { appId: string; country: string },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<AppStoreListing> {
  const fetchImpl = deps.fetchImpl ?? ssrfSafeFetch;
  const url = `${ITUNES_LOOKUP_BASE}?id=${encodeURIComponent(input.appId)}&country=${encodeURIComponent(input.country)}`;

  let payload: { resultCount?: number; results?: LookupResult[] };
  try {
    const res = await fetchImpl(url);
    if (!res.ok) throw new AppStoreLookupError("APP_STORE_LOOKUP_FAILED");
    payload = (await res.json()) as typeof payload;
  } catch (err) {
    if (err instanceof AppStoreLookupError) throw err;
    throw new AppStoreLookupError("APP_STORE_LOOKUP_FAILED");
  }

  const result = payload.results?.[0];
  if (!payload.resultCount || !result) throw new AppStoreLookupError("APP_NOT_FOUND");

  return {
    name: result.trackName ?? "",
    description: result.description ?? "",
    iconUrl: result.artworkUrl512 ?? result.artworkUrl100 ?? "",
    screenshotUrls: result.screenshotUrls ?? [],
    artistName: result.artistName ?? "",
  };
}

/** ≤ IMPORT_MAX_DESCRIPTION_CHARS, cut at the last word boundary, "…" appended when cut. */
function truncateAtWordBoundary(text: string): string {
  if (text.length <= IMPORT_MAX_DESCRIPTION_CHARS) return text;
  const slice = text.slice(0, IMPORT_MAX_DESCRIPTION_CHARS);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}${ELLIPSIS}`;
}

/**
 * Assembles the imported draft: icon → title → body → screenshot carousel →
 * packageList + purchaseButton skeleton. Every listing STRING lands in the
 * default locale's table (never in node structure — the injection posture),
 * node ids come from a local counter, and the result is gated through
 * `assertSaveValid` so a save-invalid tree can never leave this function.
 * Publish-tier gaps (no offering chosen yet) are expected and allowed.
 */
export function buildImportTree(listing: AppStoreListing, defaultLocale: string): BuilderConfig {
  let counter = 0;
  const nextId = () => `imp_${++counter}`;

  const table: Record<string, string> = {};
  const children: PaywallNode[] = [];

  if (listing.iconUrl) {
    children.push({
      type: "image",
      id: nextId(),
      url: { light: listing.iconUrl },
      alt: listing.name,
    });
  }

  const titleKey = "imp_title";
  table[titleKey] = listing.name;
  children.push({ type: "text", id: nextId(), key: titleKey, role: "title" });

  if (listing.description) {
    const bodyKey = "imp_body";
    table[bodyKey] = truncateAtWordBoundary(listing.description);
    children.push({ type: "text", id: nextId(), key: bodyKey, role: "body" });
  }

  const screenshots = listing.screenshotUrls.slice(0, IMPORT_MAX_SCREENSHOTS);
  if (screenshots.length > 0) {
    children.push({
      type: "carousel",
      id: nextId(),
      children: screenshots.map(
        (url): PaywallNode => ({
          type: "image",
          id: nextId(),
          url: { light: url },
          alt: listing.name,
        }),
      ),
    });
  }

  children.push({ type: "packageList", id: nextId(), packageIds: [], cellLayout: "row" });
  const ctaKey = "imp_cta";
  table[ctaKey] = IMPORT_CTA_DEFAULT;
  children.push({ type: "purchaseButton", id: nextId(), labelKey: ctaKey });

  const config: BuilderConfig = {
    formatVersion: 2,
    defaultLocale,
    localizations: { [defaultLocale]: table },
    root: { type: "stack", id: "root", axis: "v", children },
  };

  return assertSaveValid(config);
}
