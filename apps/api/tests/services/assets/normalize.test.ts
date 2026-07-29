import { describe, it, expect, beforeAll } from "vitest";
import sharp from "sharp";
import { applySharpHardening } from "../../../src/services/assets/sharp-hardening";
import {
  normalizeImage,
  AssetProcessingError,
} from "../../../src/services/assets/normalize";
import { ASSET_IMAGE_MAX_EDGE_PX } from "@rovenue/shared";

beforeAll(() => {
  applySharpHardening();
});

/** A solid-colour PNG of the given size, built in-process so the test
 *  needs no binary fixture checked into the repo. */
async function png(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
}

/** A PNG header that CLAIMS `width` x `height` without any pixel data
 *  behind it — the decompression-bomb fixture. Signature + a single
 *  IHDR chunk is enough for libvips to read the dimensions and refuse
 *  on the pixel limit, so the test never allocates what it is testing
 *  the rejection of. */
function pngWithDeclaredSize(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8; // bit depth
  data[9] = 2; // colour type: truecolour
  // bytes 10-12: compression, filter, interlace — all zero
  const type = Buffer.from("IHDR", "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])), 0);
  return Buffer.concat([signature, length, type, data, crc]);
}

/** CRC-32 as PNG specifies it. Table built once, on first use. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

describe("normalizeImage", () => {
  it("converts a PNG to WebP", async () => {
    const out = await normalizeImage(await png(400, 300));
    const meta = await sharp(out.bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(out.width).toBe(400);
    expect(out.height).toBe(300);
  });

  it("records the source dimensions, which the discarded original no longer carries", async () => {
    const out = await normalizeImage(await png(4000, 1000));
    expect(out.sourceWidth).toBe(4000);
    expect(out.sourceHeight).toBe(1000);
  });

  it("fits the longest edge to the ceiling and preserves aspect ratio", async () => {
    const out = await normalizeImage(await png(4000, 1000));
    expect(out.width).toBe(ASSET_IMAGE_MAX_EDGE_PX);
    expect(out.height).toBe(ASSET_IMAGE_MAX_EDGE_PX / 4);
  });

  it("fits the longest edge when the image is portrait", async () => {
    const out = await normalizeImage(await png(1000, 4000));
    expect(out.height).toBe(ASSET_IMAGE_MAX_EDGE_PX);
    expect(out.width).toBe(ASSET_IMAGE_MAX_EDGE_PX / 4);
  });

  it("never upscales a small image", async () => {
    const out = await normalizeImage(await png(100, 80));
    expect(out.width).toBe(100);
    expect(out.height).toBe(80);
  });

  it("strips metadata, including EXIF GPS", async () => {
    const withExif = await sharp(await png(200, 200))
      .withExif({ IFD0: { Copyright: "someone" }, GPS: { GPSLatitudeRef: "N" } })
      .jpeg()
      .toBuffer();
    const out = await normalizeImage(withExif);
    const meta = await sharp(out.bytes).metadata();
    expect(meta.exif).toBeUndefined();
  });

  it("preserves animation when converting an animated GIF", async () => {
    // Two distinct 32x32 frames joined into a genuinely multi-page GIF.
    // (A single flat image re-loaded with `{ animated: true }` reports
    // one page, not two — libvips needs real per-frame image data, not
    // just a tall buffer, to treat something as animated.)
    const frame1 = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const frame2 = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 0, g: 255, b: 0 } },
    })
      .png()
      .toBuffer();
    const animated = await sharp([frame1, frame2], { join: { across: 1, animated: true } })
      .gif()
      .toBuffer();
    const out = await normalizeImage(animated);
    const meta = await sharp(out.bytes, { animated: true }).metadata();
    expect(meta.format).toBe("webp");
    // The format assertion alone would pass for a flattened first frame,
    // which is exactly the failure this test exists to catch.
    expect(meta.pages).toBeGreaterThan(1);
  });

  it("rejects a decompression bomb rather than allocating it", async () => {
    // The fixture must DECLARE huge dimensions without the test itself
    // allocating them — `sharp({create: {width: 30000, height: 30000}})`
    // would need ~2.7 GB of RGB before it ever reached the code under
    // test, which is the very failure the limit exists to prevent.
    //
    // libvips reads dimensions from the header, so a hand-built PNG
    // whose IHDR claims a huge size is enough to trip the limit. Build
    // the 8-byte PNG signature, then an IHDR chunk (length, "IHDR",
    // width, height, bit depth 8, colour type 2, three zero bytes)
    // with a correct CRC32 over the chunk type and data. No IDAT is
    // needed: the pixel-count check must reject it before any decode.
    const bomb = pngWithDeclaredSize(30000, 30000);
    await expect(normalizeImage(bomb)).rejects.toBeInstanceOf(AssetProcessingError);
  });

  it("rejects SVG, whose loader is blocked", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    );
    await expect(normalizeImage(svg)).rejects.toBeInstanceOf(AssetProcessingError);
  });

  it("rejects corrupt input", async () => {
    await expect(normalizeImage(Buffer.from("not an image"))).rejects.toBeInstanceOf(
      AssetProcessingError,
    );
  });
});
