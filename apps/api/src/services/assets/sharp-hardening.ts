import sharp from "sharp";

// =============================================================
// sharp / libvips hardening — applied once, at process start
// =============================================================
//
// We hand attacker-supplied bytes to an image decoder, so the decoder
// gets locked down to the smallest surface that does the job.
//
// The allowlist is the primary control, not `VIPS_BLOCK_UNTRUSTED`.
// "Untrusted" is upstream's classification and can be re-tagged between
// releases; "these four loaders and nothing else" is ours and does not
// move. `VIPS_BLOCK_UNTRUSTED` is still set in the image as a second
// layer (design spec §5.4).
//
// SVG is the specific reason this exists. Rasterising SVG would have
// been genuinely useful — neither SwiftUI nor Android Views render SVG
// natively — but it means handing XML to librsvg, which has a history
// of directory-traversal and external-resource issues, from an
// authenticated dashboard user. Not worth it.
//
// sharp >= 0.35.3 is a hard floor for CVE-2026-33327 / 33328 / 35590 /
// 35591, which land in the GIF, TIFF and VIPS loaders. GIF is on our
// accept list.

/** libvips operation classes for the loaders we accept.
 *
 *  GIF is `VipsForeignLoadNsgif`, not `VipsForeignLoadGif`: this libvips
 *  build (8.18.x, bundled with sharp 0.35.3) decodes GIF via libnsgif,
 *  not the older giflib-backed loader that name would suggest. Verified
 *  against the installed binary — unblocking the wrong name is a
 *  silent no-op (GIF stays blocked) rather than an error, so this was
 *  checked by round-tripping a real GIF through the hardened pipeline,
 *  not just by reading libvips source. */
const ALLOWED_LOADERS = [
  "VipsForeignLoadJpeg",
  "VipsForeignLoadPng",
  "VipsForeignLoadWebp",
  "VipsForeignLoadNsgif",
] as const;

let applied = false;

export function applySharpHardening(): void {
  if (applied) return;
  // Block every loader, then re-enable only ours. Blocking the base
  // class and unblocking children is what makes this an allowlist
  // rather than a denylist that new upstream loaders slip past.
  sharp.block({ operation: ["VipsForeignLoad"] });
  sharp.unblock({ operation: [...ALLOWED_LOADERS] });
  applied = true;
}
