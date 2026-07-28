export type FontFormat = "otf" | "ttf" | "woff2";

export const FONT_ALLOWED_FORMATS: readonly FontFormat[] = ["otf", "ttf", "woff2"];

/** One uploaded face. 2 MB comfortably holds a full-featured OTF. */
export const FONT_FACE_MAX_BYTES = 2 * 1024 * 1024;
/** Four families at six weights — a bound on storage, not a ration. */
export const FONT_FACES_MAX_PER_PROJECT = 24;
/** A face's bytes never change (a re-upload creates a new row), so the
 *  served file is immutable for a year. */
export const FONT_FILE_CACHE_MAX_AGE_SECONDS = 31536000;

export const FONT_CONTENT_TYPES: Record<FontFormat, string> = {
  otf: "font/otf",
  ttf: "font/ttf",
  woff2: "font/woff2",
};

/** Leading-byte signatures. WOFF1 is deliberately absent: not every
 *  platform loader accepts it, and accepting an upload that works on one
 *  platform only is the failure this wave's design removed. */
const SIGNATURES: ReadonlyArray<{ format: FontFormat; magic: readonly number[] }> = [
  { format: "otf", magic: [0x4f, 0x54, 0x54, 0x4f] },            // "OTTO"
  { format: "ttf", magic: [0x00, 0x01, 0x00, 0x00] },
  { format: "ttf", magic: [0x74, 0x72, 0x75, 0x65] },            // "true"
  { format: "woff2", magic: [0x77, 0x4f, 0x46, 0x32] },          // "wOF2"
];

const SIGNATURE_LENGTH = 4;

/** The format a file's own bytes claim, or null. NOT a parse — this reads
 *  four bytes. Font parsers have a long history of memory-safety bugs and
 *  running one over an attacker-supplied file on our servers, to save the
 *  uploader typing a family name, is a bad trade. */
export function detectFontFormat(bytes: Uint8Array): FontFormat | null {
  if (bytes.length < SIGNATURE_LENGTH) return null;
  for (const { format, magic } of SIGNATURES) {
    if (magic.every((b, i) => bytes[i] === b)) return format;
  }
  return null;
}
