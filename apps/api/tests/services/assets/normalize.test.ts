import { describe, it, expect, beforeAll } from "vitest";
import { deflateSync } from "node:zlib";
import sharp from "sharp";
import { applySharpHardening, ALLOWED_LOADERS } from "../../../src/services/assets/sharp-hardening";
import {
  normalizeImage,
  AssetProcessingError,
} from "../../../src/services/assets/normalize";
import { ASSET_IMAGE_MAX_EDGE_PX, ASSET_IMAGE_WEBP_QUALITY } from "@rovenue/shared";

/** Built once, before `applySharpHardening()` runs, to prove this
 *  libvips build can genuinely decode TIFF. Without this, "normalizeImage
 *  rejects TIFF" would be ambiguous evidence — it could mean the
 *  allowlist blocked it, or it could mean this build has no TIFF
 *  support at all, in which case the allowlist proves nothing. */
let tiffBuffer: Buffer;
let tiffDecodableBeforeHardening: boolean;

beforeAll(async () => {
  tiffBuffer = await sharp({
    create: { width: 20, height: 20, channels: 3, background: { r: 5, g: 6, b: 7 } },
  })
    .tiff()
    .toBuffer();
  const preHardeningMeta = await sharp(tiffBuffer).metadata();
  tiffDecodableBeforeHardening = preHardeningMeta.format === "tiff";

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

/** A solid-colour image of the given size and libvips save format,
 *  used for the accepted-format round-trip table below. */
function solid(
  width: number,
  height: number,
  // `sharp.Sharp` as a type reference needs `sharp` bound as a namespace,
  // which the default `import sharp from "sharp"` above doesn't give under
  // this program's module settings (TS2503, "cannot find namespace
  // 'sharp'") — `ReturnType<typeof sharp>` names the same instance type
  // sharp(...) actually returns, without a namespace reference.
  save: (s: ReturnType<typeof sharp>) => ReturnType<typeof sharp>,
): Promise<Buffer> {
  const s = sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 50, b: 90 } },
  });
  return save(s).toBuffer();
}

/** One entry per accepted loader, keyed by the exact libvips class name
 *  from `ALLOWED_LOADERS`. The guard test just below asserts this table
 *  and the allowlist stay the same length and cover the same classes —
 *  a fifth loader added to the allowlist without a matching entry here
 *  fails immediately, which is exactly the gap that hid the
 *  `VipsForeignLoadGif` vs `VipsForeignLoadNsgif` mismatch. */
const ACCEPTED_FORMATS: Array<{
  name: string;
  loader: (typeof ALLOWED_LOADERS)[number];
  build: () => Promise<Buffer>;
}> = [
  { name: "jpeg", loader: "VipsForeignLoadJpeg", build: () => solid(64, 48, (s) => s.jpeg()) },
  { name: "png", loader: "VipsForeignLoadPng", build: () => solid(64, 48, (s) => s.png()) },
  { name: "webp", loader: "VipsForeignLoadWebp", build: () => solid(64, 48, (s) => s.webp()) },
  { name: "gif", loader: "VipsForeignLoadNsgif", build: () => solid(64, 48, (s) => s.gif()) },
];

/** A PNG that DECLARES `width` x `height` in its header and carries a
 *  structurally valid (but empty) IDAT stream — enough for libvips to
 *  parse it as a real, complete PNG and apply the pixel-count limit
 *  against the declared dimensions, without the test itself allocating
 *  the pixels it claims. An IHDR-only buffer (no IDAT) is NOT enough:
 *  empirically it fails PNG structural validation first ("Input buffer
 *  has corrupt header") regardless of `limitInputPixels`, which would
 *  make the bomb test pass for the wrong reason — see the mutation
 *  check in the "rejects a decompression bomb" test below. */
function pngWithDeclaredSize(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // colour type: truecolour
  // bytes 10-12: compression, filter, interlace — all zero
  // A valid zlib stream with no decompressed bytes: structurally a real
  // IDAT, but it carries none of the ~2.7 GB of pixels the declared
  // dimensions imply.
  const emptyIdat = deflateSync(Buffer.alloc(0));
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdrData),
    pngChunk("IDAT", emptyIdat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
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

/** Runs `normalizeImage` and returns the rejection, asserting it is an
 *  `AssetProcessingError` with an `Error` cause — used by the tests that
 *  need to inspect *why* normalization failed, not just that it did. */
async function rejection(input: Buffer): Promise<{ error: AssetProcessingError; causeMessage: string }> {
  const error = await normalizeImage(input).then(
    () => {
      throw new Error("expected normalizeImage to reject");
    },
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(AssetProcessingError);
  const assetError = error as AssetProcessingError;
  expect(assetError.cause).toBeInstanceOf(Error);
  return { error: assetError, causeMessage: (assetError.cause as Error).message };
}

describe("normalizeImage", () => {
  it("converts a PNG to WebP", async () => {
    const out = await normalizeImage(await png(400, 300));
    const meta = await sharp(out.bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(out.width).toBe(400);
    expect(out.height).toBe(300);
  });

  it("has a round-trip case for every allowed loader", () => {
    // A fifth loader added to ALLOWED_LOADERS without a matching entry
    // in ACCEPTED_FORMATS fails this before it fails anything else.
    const covered = [...ACCEPTED_FORMATS.map((f) => f.loader)].sort();
    expect(covered).toEqual([...ALLOWED_LOADERS].sort());
  });

  describe.each(ACCEPTED_FORMATS)("accepted format: $name", ({ build }) => {
    it("normalizes to WebP", async () => {
      const input = await build();
      const out = await normalizeImage(input);
      const meta = await sharp(out.bytes).metadata();
      expect(meta.format).toBe("webp");
      expect(out.width).toBe(64);
      expect(out.height).toBe(48);
    });
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
    // `GPS` isn't a key sharp's Exif type (or libvips underneath it)
    // recognizes — GPS tags live under the GPS IFD, which this API
    // addresses as `IFD3` (confirmed empirically: a `GPS` key here writes
    // byte-identical output to an IFD0-only exif — the tag is silently
    // dropped, never reaching the file at all, so this test previously
    // asserted nothing about GPS stripping specifically).
    const withExif = await sharp(await png(200, 200))
      .withExif({ IFD0: { Copyright: "someone" }, IFD3: { GPSLatitudeRef: "N" } })
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
    // `out.height` is `info.height / meta.pages` in the implementation —
    // easy to get backwards (toilet-roll height vs. per-frame height).
    // Each source frame is 32x32, so the normalized per-frame size must
    // come back 32x32, not 32x64.
    expect(out.sourceWidth).toBe(32);
    expect(out.sourceHeight).toBe(32);
    expect(out.width).toBe(32);
    expect(out.height).toBe(32);
  });

  it("rejects a decompression bomb rather than allocating it, specifically via the pixel limit", async () => {
    // The fixture must DECLARE huge dimensions without the test itself
    // allocating them — `sharp({create: {width: 30000, height: 30000}})`
    // would need ~2.7 GB of RGB before it ever reached the code under
    // test, which is the very failure the limit exists to prevent.
    const bomb = pngWithDeclaredSize(30000, 30000);
    const { causeMessage } = await rejection(bomb);

    // Distinguish "rejected because it's too big" from "rejected because
    // it's broken" — both surface as AssetProcessingError, so the cause
    // message is the only observable difference. Determined empirically
    // (see task-4 fix report) rather than guessed: sharp's PNG loader
    // reports this exact string when the declared pixel count exceeds
    // `limitInputPixels`, checked against the header alone.
    expect(causeMessage).toMatch(/pixel limit/i);
  });

  it("proves the pixel limit is what rejects the bomb: disabling it changes the failure", async () => {
    // Mutation-style check for the test above. With the limit removed,
    // libvips reads the (valid, if empty) header fine and only fails
    // once it tries to actually decode pixel rows that were never
    // written — a different, later, decode-level error. If this test
    // ever reports the SAME message as the one above, the "pixel limit"
    // assertion above has stopped being meaningful.
    const bomb = pngWithDeclaredSize(30000, 30000);
    await expect(
      sharp(bomb, { animated: true, limitInputPixels: false, failOn: "warning" })
        .resize({
          width: ASSET_IMAGE_MAX_EDGE_PX,
          height: ASSET_IMAGE_MAX_EDGE_PX,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: ASSET_IMAGE_WEBP_QUALITY })
        .toBuffer(),
    ).rejects.toThrow(/libpng read error/i);
  });

  it("rejects SVG, whose loader is blocked", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    );
    await rejection(svg);
  });

  it("rejects TIFF — a raster format this libvips build can decode — because the loader allowlist blocks it", async () => {
    // The differential is the actual proof: the SAME bytes decode fine
    // through plain, unhardened sharp (captured in beforeAll, before
    // applySharpHardening() narrowed the loader set) and are rejected
    // once the allowlist is in force. Without that contrast, "TIFF is
    // rejected" would be equally consistent with "this build has no
    // TIFF support at all", which would make the test worthless — TIFF
    // matters here specifically because it's one of the loaders named
    // in the CVEs that set the sharp version floor.
    expect(tiffDecodableBeforeHardening).toBe(true);
    await rejection(tiffBuffer);
  });

  it("rejects corrupt input, for a different reason than the pixel-limit bomb", async () => {
    const { causeMessage } = await rejection(Buffer.from("not an image"));
    expect(causeMessage).not.toMatch(/pixel limit/i);
    expect(causeMessage).toMatch(/unsupported image format/i);
  });
});
