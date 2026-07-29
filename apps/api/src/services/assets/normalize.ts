import sharp from "sharp";
import {
  ASSET_IMAGE_MAX_EDGE_PX,
  ASSET_IMAGE_WEBP_QUALITY,
  ASSET_NORMALIZE_POLICY_VERSION,
} from "@rovenue/shared";

// =============================================================
// normalizeImage — the one derivative an uploaded image becomes
// =============================================================
//
// Pure: no database, no storage. One canonical WebP, because the tree
// holds a single plain URL string and therefore cannot carry a
// responsive candidate set (design spec §2.4).
//
// The original is DISCARDED after this runs, which makes the policy
// permanent per asset — hence `sourceWidth`/`sourceHeight`/
// `policyVersion` on the way out. They cannot bring the bytes back,
// but they make "which assets were captured under the old policy"
// answerable.

export class AssetProcessingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AssetProcessingError";
  }
}

export interface NormalizedImage {
  bytes: Buffer;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  policyVersion: number;
}

export async function normalizeImage(input: Buffer): Promise<NormalizedImage> {
  try {
    // Both options are already the values we want by default. They are
    // written down anyway so an upstream default change cannot silently
    // remove the decompression-bomb bound, and because sharp's own
    // documentation says to use failOn: 'warning' with untrusted input.
    const pipeline = sharp(input, {
      animated: true,
      limitInputPixels: 268402689,
      failOn: "warning",
    });

    const meta = await pipeline.metadata();
    const sourceWidth = meta.width ?? 0;
    // For an animated image sharp reports the "toilet roll" height;
    // `pageHeight` is the real frame height.
    const sourceHeight = meta.pageHeight ?? meta.height ?? 0;
    if (sourceWidth === 0 || sourceHeight === 0) {
      throw new AssetProcessingError("Image has no usable dimensions");
    }

    const { data, info } = await pipeline
      .resize({
        width: ASSET_IMAGE_MAX_EDGE_PX,
        height: ASSET_IMAGE_MAX_EDGE_PX,
        fit: "inside",
        withoutEnlargement: true,
      })
      // No `.withMetadata()` — omitting it is what strips EXIF, ICC and
      // everything else, GPS coordinates included.
      .webp({ quality: ASSET_IMAGE_WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });

    return {
      bytes: data,
      width: info.width,
      height: meta.pages && meta.pages > 1 ? info.height / meta.pages : info.height,
      sourceWidth,
      sourceHeight,
      policyVersion: ASSET_NORMALIZE_POLICY_VERSION,
    };
  } catch (err) {
    if (err instanceof AssetProcessingError) throw err;
    throw new AssetProcessingError("Failed to process image", { cause: err });
  }
}
