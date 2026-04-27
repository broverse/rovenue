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
const frozen = new Set<string>([
  // Apple Root CA - G3 (ECC) — apple.com/certificateauthority
  "63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179",
  // Apple Inc. Root Certificate (RSA, legacy)
  "b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024",
]);
frozen.add = () => {
  throw new Error("APPLE_ROOT_FINGERPRINTS is immutable");
};
frozen.delete = () => {
  throw new Error("APPLE_ROOT_FINGERPRINTS is immutable");
};
frozen.clear = () => {
  throw new Error("APPLE_ROOT_FINGERPRINTS is immutable");
};

export const APPLE_ROOT_FINGERPRINTS: ReadonlySet<string> = frozen;

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
