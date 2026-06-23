import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { buildOfferSignaturePayload, signOfferPayload } from "./offer-signature";

const SEP = "⁣";

describe("buildOfferSignaturePayload", () => {
  it("joins fields in Apple's exact order with U+2063", () => {
    const payload = buildOfferSignaturePayload({
      bundleId: "com.acme.app", keyId: "ABC123DEFG", productId: "premium_monthly",
      offerId: "winback10", appAccountToken: "a1b2", nonce: "11111111-1111-1111-1111-111111111111",
      timestamp: 1719100000000,
    });
    expect(payload).toBe(
      ["com.acme.app", "ABC123DEFG", "premium_monthly", "winback10", "a1b2",
       "11111111-1111-1111-1111-111111111111", "1719100000000"].join(SEP)
    );
  });
});

describe("signOfferPayload", () => {
  it("produces a Base64 DER ECDSA-SHA256 signature that verifies", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const payload = "hello⁣world";
    const sigB64 = signOfferPayload(payload, pem);
    const ok = cryptoVerify(
      "sha256", Buffer.from(payload, "utf8"),
      { key: publicKey, dsaEncoding: "der" },
      Buffer.from(sigB64, "base64"),
    );
    expect(ok).toBe(true);
  });
});
