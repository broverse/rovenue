import { ASSET_MAX_BYTES, type AssetKind, type ImageSourceFormat } from "./constants";

// =============================================================
// detectAssetKind — what the bytes themselves claim to be
// =============================================================
//
// A shape check, not a parse — the same posture as `detectFontFormat`.
// The uploader's filename is never consulted, and the `kind` path
// segment is checked AGAINST this result rather than trusted.
//
// SVG is deliberately absent. It is text, not magic bytes, and
// accepting it would mean handing attacker-supplied XML to librsvg;
// the libvips loader allowlist blocks it at the other end too
// (design spec §5.4).

export interface DetectedAsset {
  kind: AssetKind;
  /** Only meaningful for `kind: "image"`; null otherwise. */
  sourceFormat: ImageSourceFormat | null;
}

const IMAGE_SIGNATURES: ReadonlyArray<{
  format: ImageSourceFormat;
  offset: number;
  magic: readonly number[];
}> = [
  { format: "png", offset: 0, magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { format: "jpeg", offset: 0, magic: [0xff, 0xd8, 0xff] },
  { format: "gif", offset: 0, magic: [0x47, 0x49, 0x46, 0x38] }, // "GIF8"
];

const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46] as const; // "RIFF"
const WEBP_TAG = [0x57, 0x45, 0x42, 0x50] as const; // "WEBP"
const WEBP_TAG_OFFSET = 8;
const FTYP_MAGIC = [0x66, 0x74, 0x79, 0x70] as const; // "ftyp"
const FTYP_OFFSET = 4;

/** ISO/IEC 14496-12 §4.3: the `ftyp` box's `major_brand` field sits
 *  immediately after the 4-byte box size and the `ftyp` marker itself. */
const MP4_MAJOR_BRAND_OFFSET = FTYP_OFFSET + FTYP_MAGIC.length;
const MP4_MAJOR_BRAND_LENGTH = 4;

/** The `ftyp` marker alone is shared by every ISO-BMFF container — MOV
 *  (`qt  `), 3GP, HEIF/HEIC (`heic`, `heix`, `mif1`, `msf1`), AVIF
 *  (`avif`, `avis`) — so checking only the marker (design spec §5.3's
 *  table names "ftyp box at offset 4") lets any of those pass as MP4
 *  and get served as `video/mp4`, rendering as a broken video on every
 *  platform. This is the major_brand allowlist for what this wave
 *  accepts as genuinely MP4 — the brands real encoders (ffmpeg,
 *  QuickTime's MP4 export, iOS/Android camera output) actually write. */
const MP4_MAJOR_BRANDS: ReadonlySet<string> = new Set([
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "M4V ",
  "M4A ",
  "M4P ",
  "dash",
]);

/** Enough bytes to hold the longest signature we check plus its offset
 *  — the MP4 check, marker plus major_brand. */
const MIN_BYTES_FOR_BINARY_SIGNATURE = MP4_MAJOR_BRAND_OFFSET + MP4_MAJOR_BRAND_LENGTH;

function matches(bytes: Uint8Array, offset: number, magic: readonly number[]): boolean {
  if (bytes.length < offset + magic.length) return false;
  return magic.every((b, i) => bytes[offset + i] === b);
}

/** Reads the 4-byte `major_brand` at {@link MP4_MAJOR_BRAND_OFFSET} as
 *  ASCII — brands are always 4 printable ASCII characters (padded with
 *  a trailing space, e.g. `"M4V "`), never arbitrary bytes. Callers
 *  only reach this after `bytes.length >= MIN_BYTES_FOR_BINARY_SIGNATURE`
 *  has already been checked, so the brand's 4 bytes are always present. */
function mp4MajorBrand(bytes: Uint8Array): string {
  let brand = "";
  for (let i = 0; i < MP4_MAJOR_BRAND_LENGTH; i += 1) {
    brand += String.fromCharCode(bytes[MP4_MAJOR_BRAND_OFFSET + i]!);
  }
  return brand;
}

/** A Lottie file is JSON, so it has no magic bytes. `v` (bodymovin
 *  version) and `layers` together are what distinguishes it from any
 *  other JSON an author might upload by mistake. */
function detectLottie(bytes: Uint8Array): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;
  return typeof obj.v === "string" && Array.isArray(obj.layers);
}

export function detectAssetKind(bytes: Uint8Array): DetectedAsset | null {
  if (bytes.length >= MIN_BYTES_FOR_BINARY_SIGNATURE) {
    for (const { format, offset, magic } of IMAGE_SIGNATURES) {
      if (matches(bytes, offset, magic)) {
        return { kind: "image", sourceFormat: format };
      }
    }
    // WebP needs both halves: "RIFF" alone is also WAV and AVI.
    if (matches(bytes, 0, RIFF_MAGIC) && matches(bytes, WEBP_TAG_OFFSET, WEBP_TAG)) {
      return { kind: "image", sourceFormat: "webp" };
    }
    if (matches(bytes, FTYP_OFFSET, FTYP_MAGIC) && MP4_MAJOR_BRANDS.has(mp4MajorBrand(bytes))) {
      return { kind: "video", sourceFormat: null };
    }
  }
  // Only worth the decode+parse when the body could possibly BE a
  // Lottie file — one larger than the Lottie cap can never be accepted
  // regardless of what it parses as (uploadHandler's per-kind bodyLimit
  // already rejects it on the lottie route, and no other route reaches
  // this branch with a real Lottie). Without this bound, a large
  // non-matching body on ANY kind's route (e.g. 50 MB of random bytes
  // to .../assets/video) pays a full UTF-8 decode of the whole buffer
  // before JSON.parse fails on its first byte — exactly the resident-
  // memory cost the three-way bodyLimit split (module comment,
  // routes/dashboard/assets.ts) exists to bound.
  if (bytes.length <= ASSET_MAX_BYTES.lottie && detectLottie(bytes)) {
    return { kind: "lottie", sourceFormat: null };
  }
  return null;
}
