// =============================================================
// formatAssetByteSize — shared by the asset library and the picker
// =============================================================
//
// Assets range from a few KB (a Lottie) to the 50 MB video cap
// (ASSET_MAX_BYTES.video, @rovenue/shared), unlike fonts (a flat KB
// scale sufficed there, see settings/fonts.tsx's own formatByteSize).
// These are unit-conversion facts (1024 bytes per KB), not product
// policy, so naming them here doesn't duplicate anything the shared
// package owns.

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * 1024;
const DECIMAL_PLACES = 1;

export function formatAssetByteSize(byteSize: number): string {
  if (byteSize >= BYTES_PER_MB) {
    return `${(byteSize / BYTES_PER_MB).toFixed(DECIMAL_PLACES)} MB`;
  }
  if (byteSize >= BYTES_PER_KB) {
    return `${(byteSize / BYTES_PER_KB).toFixed(DECIMAL_PLACES)} KB`;
  }
  return `${byteSize} B`;
}
