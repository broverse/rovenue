import { createPrivateKey, sign as cryptoSign } from "node:crypto";

/** Apple's invisible separator (U+2063) for the offer-signature payload. */
const SEP = "⁣";

export function buildOfferSignaturePayload(p: {
  bundleId: string;
  keyId: string;
  productId: string;
  offerId: string;
  appAccountToken: string;
  nonce: string;
  timestamp: number;
}): string {
  return [
    p.bundleId,
    p.keyId,
    p.productId,
    p.offerId,
    p.appAccountToken,
    p.nonce,
    String(p.timestamp),
  ].join(SEP);
}

/**
 * Sign the offer payload with the project's In-App Purchase .p8 (PKCS#8 PEM)
 * using ECDSA P-256 + SHA-256, DER-encoded, returned Base64. StoreKit decodes
 * this Base64 back into the `signature: Data` purchase option.
 */
export function signOfferPayload(payload: string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  const der = cryptoSign("sha256", Buffer.from(payload, "utf8"), {
    key,
    dsaEncoding: "der",
  });
  return der.toString("base64");
}
