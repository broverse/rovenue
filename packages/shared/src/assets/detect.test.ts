import { describe, it, expect } from "vitest";
import { detectAssetKind } from "./detect";

/** Builds a buffer whose first bytes are `magic`, padded to `length`. */
function withMagic(magic: number[], length = 64): Uint8Array {
  const b = new Uint8Array(length);
  b.set(magic, 0);
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

  it("detects MP4 by the ftyp box at offset 4", () => {
    const b = new Uint8Array(64);
    b.set([0x00, 0x00, 0x00, 0x20], 0); // box size
    b.set([0x66, 0x74, 0x79, 0x70], 4); // "ftyp"
    expect(detectAssetKind(b)).toEqual({ kind: "video", sourceFormat: null });
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

  it("rejects SVG — it is not an accepted format", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    expect(detectAssetKind(new TextEncoder().encode(svg))).toBeNull();
  });

  it("rejects a truncated header without throwing", () => {
    expect(detectAssetKind(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(detectAssetKind(new Uint8Array())).toBeNull();
  });
});
