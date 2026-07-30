import { describe, it, expect } from "vitest";
import { ASSET_MAX_BYTES } from "./constants";
import { detectAssetKind } from "./detect";

/** Builds a buffer whose first bytes are `magic`, padded to `length`. */
function withMagic(magic: number[], length = 64): Uint8Array {
  const b = new Uint8Array(length);
  b.set(magic, 0);
  return b;
}

/** A real MP4 `ftyp` box prefix: box size, the `ftyp` marker at offset
 *  4, and a real major_brand at offset 8 — `brand` defaults to `isom`,
 *  the brand ffmpeg and most encoders write. */
function ftypBytes(brand = "isom", length = 64): Uint8Array {
  const b = new Uint8Array(length);
  b.set([0x00, 0x00, 0x00, 0x20], 0); // box size
  b.set([0x66, 0x74, 0x79, 0x70], 4); // "ftyp"
  for (let i = 0; i < 4; i += 1) b[8 + i] = brand.charCodeAt(i);
  return b;
}

describe("detectAssetKind", () => {
  it("detects PNG", () => {
    const b = withMagic([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectAssetKind(b)).toEqual({ kind: "image", sourceFormat: "png" });
  });

  it("detects JPEG", () => {
    expect(detectAssetKind(withMagic([0xff, 0xd8, 0xff]))).toEqual({
      kind: "image",
      sourceFormat: "jpeg",
    });
  });

  it("detects GIF87a and GIF89a", () => {
    // "GIF87a" / "GIF89a"
    expect(detectAssetKind(withMagic([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]))).toEqual({
      kind: "image",
      sourceFormat: "gif",
    });
    expect(detectAssetKind(withMagic([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toEqual({
      kind: "image",
      sourceFormat: "gif",
    });
  });

  it("detects WebP, which needs both the RIFF prefix and the WEBP tag at offset 8", () => {
    const b = new Uint8Array(64);
    b.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
    b.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
    expect(detectAssetKind(b)).toEqual({ kind: "image", sourceFormat: "webp" });
  });

  it("rejects a RIFF container that is not WebP (e.g. WAV)", () => {
    const b = new Uint8Array(64);
    b.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
    b.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
    expect(detectAssetKind(b)).toBeNull();
  });

  it("detects MP4 by the ftyp box at offset 4 with a real major_brand", () => {
    expect(detectAssetKind(ftypBytes("isom"))).toEqual({
      kind: "video",
      sourceFormat: null,
    });
  });

  it.each(["iso2", "mp41", "mp42", "avc1", "M4V ", "dash"])(
    "accepts major_brand %s",
    (brand) => {
      expect(detectAssetKind(ftypBytes(brand))).toEqual({
        kind: "video",
        sourceFormat: null,
      });
    },
  );

  // Regression test for the brand check (review round: whole-branch
  // final review, finding 3c). Before the fix, ANY ISO-BMFF container —
  // not just MP4 — passed as MP4 because only the `ftyp` marker was
  // checked, not the major_brand that follows it. HEIC is the concrete
  // case from the finding: an iPhone photo uploaded to `.../assets/video`
  // would have been accepted, stored, and served as `video/mp4`, then
  // rendered as a broken video on every platform.
  it.each([
    ["heic", "HEIC photo"],
    ["heix", "HEIF photo"],
    ["mif1", "HEIF image sequence"],
    ["avif", "AVIF image"],
    ["qt  ", "QuickTime .mov"],
    ["3gp4", "3GPP video"],
  ])("rejects an ftyp box whose major_brand is %s (%s), not MP4", (brand) => {
    expect(detectAssetKind(ftypBytes(brand))).toBeNull();
  });

  it("rejects an ftyp box too short to carry a major_brand", () => {
    const b = new Uint8Array(10); // ends mid-brand
    b.set([0x66, 0x74, 0x79, 0x70], 4);
    expect(detectAssetKind(b)).toBeNull();
  });

  it("detects Lottie JSON carrying both v and layers", () => {
    const json = JSON.stringify({ v: "5.7.4", fr: 30, layers: [] });
    expect(detectAssetKind(new TextEncoder().encode(json))).toEqual({
      kind: "lottie",
      sourceFormat: null,
    });
  });

  it("rejects JSON that parses but is not Lottie", () => {
    const json = JSON.stringify({ hello: "world" });
    expect(detectAssetKind(new TextEncoder().encode(json))).toBeNull();
  });

  // Review finding (final whole-branch review, finding 4): a body over
  // the Lottie cap can never be accepted as Lottie regardless of what
  // it parses as — the lottie route's own bodyLimit already rejects it
  // — so this bound must reject BEFORE the decode+parse, not after. A
  // status-quo-shaped body (real Lottie JSON, just oversized) is what
  // proves the bound is actually checked rather than merely documented:
  // before the fix this returned `{ kind: "lottie", ... }` for a body
  // no lottie route would ever accept.
  it("does not detect Lottie JSON larger than the Lottie cap", () => {
    const padding = "x".repeat(ASSET_MAX_BYTES.lottie + 1);
    const json = JSON.stringify({ v: "5.7.4", layers: [], padding });
    const bytes = new TextEncoder().encode(json);
    expect(bytes.length).toBeGreaterThan(ASSET_MAX_BYTES.lottie);
    expect(detectAssetKind(bytes)).toBeNull();
  });

  it("rejects SVG — it is not an accepted format", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    expect(detectAssetKind(new TextEncoder().encode(svg))).toBeNull();
  });

  it("rejects a truncated header without throwing", () => {
    expect(detectAssetKind(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(detectAssetKind(new Uint8Array())).toBeNull();
  });
});
