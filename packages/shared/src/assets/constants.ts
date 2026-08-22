// =============================================================
// Paywall asset CDN — the numbers, in one place
// =============================================================
//
// Every cap and ceiling this wave enforces lives here so a reviewer can
// see the whole envelope at once, and so no route, worker or renderer
// ever hard-codes one of them.

export type AssetKind = "image" | "video" | "lottie";
export type ImageSourceFormat = "png" | "jpeg" | "webp" | "gif";

export const ASSET_KINDS: readonly AssetKind[] = ["image", "video", "lottie"];

/** Per-file hard caps. These are flat, not plan-tiered, because Hono's
 *  `bodyLimit` fixes `maxSize` at route-registration time and cannot
 *  vary it per request — which is exactly why the upload surface is
 *  three route registrations rather than one (design spec §3.2). */
export const ASSET_MAX_BYTES: Record<AssetKind, number> = {
  image: 10 * 1024 * 1024,
  lottie: 2 * 1024 * 1024,
  video: 50 * 1024 * 1024,
};

/**
 * Per-tier storage caps. The AUTHORITATIVE copy of these numbers is
 * `billing_tier_limits.asset_storage_bytes_limit` — a project's cap is
 * whatever its tier's row says, so an operator can tune one deployment
 * without a code change. This table is the FAIL-CLOSED fallback used
 * when that row carries no number at all.
 *
 * It exists because "no number" and "unlimited" are the same value in
 * that column (NULL), and reading NULL as unlimited fails open on a
 * paid limit. That is not hypothetical: migration 0099 filled the
 * column with an UPDATE, then 0100 seeded the ladder itself with an
 * INSERT that never listed the column — so every database built from
 * migrations alone (fresh self-host, clean CI, new cloud deploy) had a
 * NULL cap on every tier, and the quota silently did not exist.
 *
 * `null` here means genuinely unlimited and is reserved for enterprise.
 * Below enterprise, unlimited stays expressible per deployment through
 * `ASSET_STORAGE_UNLIMITED_LIMIT_BYTES` — see that constant for why the
 * column cannot use NULL for it any more.
 * Legacy tiers (pro/scale/growth, retired in the 2026-07
 * consolidation) are absent on purpose: they have no ladder row either,
 * and the resolver below answers the free cap for anything it does not
 * recognise rather than inventing a band for a tier nobody sells.
 */
export const ASSET_STORAGE_TIER_LIMIT_BYTES = {
  free: 250 * 1024 * 1024,
  indie: 5 * 1024 * 1024 * 1024,
  studio: 50 * 1024 * 1024 * 1024,
  enterprise: null,
} as const satisfies Record<string, number | null>;

export type AssetStorageTier = keyof typeof ASSET_STORAGE_TIER_LIMIT_BYTES;

/**
 * What an operator writes into `billing_tier_limits.asset_storage_bytes_limit`
 * to mean "this tier is unlimited" on a tier the shipped ladder caps.
 *
 * NULL used to carry that meaning for any tier, and cannot any more: it
 * is indistinguishable from a row nobody ever filled in, and reading an
 * unfilled row as unlimited is what silently removed the quota from
 * every fresh database. A negative byte count is meaningless as a cap,
 * so it can carry the intent without that ambiguity. Any value below
 * zero is honoured; this is the one to write.
 */
export const ASSET_STORAGE_UNLIMITED_LIMIT_BYTES = -1;

function isAssetStorageTier(tier: string): tier is AssetStorageTier {
  return tier in ASSET_STORAGE_TIER_LIMIT_BYTES;
}

/** The cap to apply when the tier's `billing_tier_limits` row carries no
 *  number. Unknown and legacy tiers get the free cap — the most
 *  conservative answer, and the one the pre-existing JOIN already gave
 *  them by not matching a ladder row at all. */
export function assetStorageFallbackLimitBytes(tier: string): number | null {
  return isAssetStorageTier(tier)
    ? ASSET_STORAGE_TIER_LIMIT_BYTES[tier]
    : ASSET_STORAGE_TIER_LIMIT_BYTES.free;
}

/** Fraction of the cap at which the dashboard warns, and at which it
 *  calls the situation critical. Storage is a stock, not a flow: an
 *  author who crosses these has to delete something or upgrade, so the
 *  signal has to arrive before the upload that fails. */
export const ASSET_STORAGE_WARN_RATIO = 0.8;
export const ASSET_STORAGE_CRITICAL_RATIO = 0.95;

/** The longest edge a normalised image is fitted into. Never upscaled.
 *  2048 covers a retina full-bleed paywall hero with room to spare. */
export const ASSET_IMAGE_MAX_EDGE_PX = 2048;

/** Bumped whenever the normalisation policy changes. Stored per asset.
 *  Originals are discarded (design spec §2.5), so this is the only way
 *  to answer "which assets were captured under the old policy". */
export const ASSET_NORMALIZE_POLICY_VERSION = 1;

/** WebP quality for the normalised derivative. */
export const ASSET_IMAGE_WEBP_QUALITY = 82;

export const ASSET_CONTENT_TYPES: Record<AssetKind, string> = {
  image: "image/webp",
  video: "video/mp4",
  lottie: "application/json",
};

export const ASSET_FILE_EXTENSIONS: Record<AssetKind, string> = {
  image: "webp",
  video: "mp4",
  lottie: "json",
};

/** Honest here, unlike the general case: an asset row is never
 *  overwritten (design spec §4.1), so a storage key's bytes are
 *  permanent and `immutable` is a true statement. */
export const ASSET_CACHE_MAX_AGE_SECONDS = 31536000;

/** How long a bucket object with no live row is left alone before the
 *  sweeper reclaims it. Without a grace window the sweeper races
 *  in-flight uploads whose row has not committed yet. */
export const ASSET_ORPHAN_GRACE_HOURS = 6;

/** Upload is the most expensive request in the product — sharp CPU,
 *  ingress bandwidth, durable storage — so it is the one that gets a
 *  route-scoped limiter. */
export const ASSET_UPLOAD_RATE_LIMIT_PER_MINUTE = 20;

export const ASSET_NAME_MAX_LENGTH = 120;
