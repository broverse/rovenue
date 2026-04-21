import { createHash } from "node:crypto";

// SHA-256 fingerprints of the DER-encoded Apple root CAs we accept.
// Sourced from https://www.apple.com/certificateauthority/
//
// These change roughly once a decade; when Apple rotates, add the new
// fingerprint here and ship before removing the old one.
//
//   Apple Root CA - G3 (ECC, used for StoreKit signing)
//   Apple Inc. Root (RSA, legacy — keep while some apps still route
//   through the old chain)
//
// PLACEHOLDERS: the hashes below must be replaced with the canonical
// values published at apple.com/certificateauthority before merging.
// Compute with:
//   openssl x509 -in AppleRootCA-G3.cer -inform DER -noout \
//     -fingerprint -sha256 | awk -F= '{print tolower($2)}' | tr -d ':'
export const APPLE_ROOT_FINGERPRINTS = new Set<string>([
  "63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c7a8d1ba7e3e5f4eae1f9b2c7dc",
  "b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024",
]);

export function fingerprintOf(der: Buffer): string {
  return createHash("sha256").update(der).digest("hex");
}

export function assertAppleRootFingerprints(buffers: Buffer[]): void {
  for (const buf of buffers) {
    const fp = fingerprintOf(buf);
    if (!APPLE_ROOT_FINGERPRINTS.has(fp)) {
      throw new Error(
        `Apple root CA fingerprint not in pinned allowlist: ${fp}`,
      );
    }
  }
}
