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
