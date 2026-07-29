import type { AssetKind, ImageSourceFormat } from "./constants";

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

/** Enough bytes to hold the longest signature we check plus its offset. */
const MIN_BYTES_FOR_BINARY_SIGNATURE = 12;

function matches(bytes: Uint8Array, offset: number, magic: readonly number[]): boolean {
  if (bytes.length < offset + magic.length) return false;
  return magic.every((b, i) => bytes[offset + i] === b);
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
    if (matches(bytes, FTYP_OFFSET, FTYP_MAGIC)) {
      return { kind: "video", sourceFormat: null };
    }
  }
  if (detectLottie(bytes)) {
    return { kind: "lottie", sourceFormat: null };
  }
  return null;
}
