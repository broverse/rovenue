import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";

vi.mock("../../lib/project-credentials", () => ({
  loadAppleCredentials: vi.fn(),
}));

import { purchasesRoute } from "./purchases";
import { loadAppleCredentials } from "../../lib/project-credentials";

const mockLoadAppleCredentials = vi.mocked(loadAppleCredentials);

function appWithProject() {
  return new Hono()
    .use("*", async (c, next) => { c.set("project", { id: "proj_1", name: "t", keyKind: "PUBLIC", apiKeyId: "k" } as any); await next(); })
    .route("/purchases", purchasesRoute);
}

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

beforeEach(() => mockLoadAppleCredentials.mockReset());

describe("POST /purchases/apple-offer-signature", () => {
  it("returns a verifiable signature payload", async () => {
    mockLoadAppleCredentials.mockResolvedValue({ bundleId: "com.acme.app", keyId: "ABC123DEFG", privateKey: pem });
    const res = await appWithProject().request("/purchases/apple-offer-signature", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ productId: "premium_monthly", offerId: "winback10", appAccountToken: "A1B2" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.keyIdentifier).toBe("ABC123DEFG");
    expect(json.data.nonce).toBe(json.data.nonce.toLowerCase());
    expect(typeof json.data.timestamp).toBe("number");
    // The returned signature verifies over the reconstructed payload.
    const SEP = "⁣";
    const payload = ["com.acme.app","ABC123DEFG","premium_monthly","winback10","a1b2",json.data.nonce,String(json.data.timestamp)].join(SEP);
    const okSig = cryptoVerify("sha256", Buffer.from(payload,"utf8"), { key: publicKey, dsaEncoding: "der" }, Buffer.from(json.data.signature, "base64"));
    expect(okSig).toBe(true);
  });

  it("returns 400 apple_offer_signing_unavailable when creds missing", async () => {
    mockLoadAppleCredentials.mockResolvedValue(null);
    const res = await appWithProject().request("/purchases/apple-offer-signature", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ productId: "p", offerId: "o" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("apple_offer_signing_unavailable");
  });
});
