import { describe, expect, it } from "vitest";
import { Webhook as SvixWebhook } from "svix";
import {
  WEBHOOK_SECRET_PREFIX,
  WEBHOOK_SECRET_BYTES,
  generateWebhookSecret,
  signWebhook,
} from "./svix-sign";
import { verifySvixSignature } from "./svix-signature";

// ---------------------------------------------------------------------------
// generateWebhookSecret
// ---------------------------------------------------------------------------

describe("generateWebhookSecret", () => {
  it("returns a whsec_-prefixed base64 secret decoding to WEBHOOK_SECRET_BYTES bytes", () => {
    const secret = generateWebhookSecret();
    expect(secret.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
    const decoded = Buffer.from(
      secret.slice(WEBHOOK_SECRET_PREFIX.length),
      "base64",
    );
    expect(decoded.length).toBe(WEBHOOK_SECRET_BYTES);
  });

  it("returns a different secret on each call", () => {
    expect(generateWebhookSecret()).not.toBe(generateWebhookSecret());
  });
});

// ---------------------------------------------------------------------------
// signWebhook — golden / cross-verified tests
// ---------------------------------------------------------------------------

describe("signWebhook", () => {
  const id = "msg_abc123";
  const timestampSec = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ hello: "world" });
  const secret = generateWebhookSecret();

  it("(a) round-trips through our own verifySvixSignature", () => {
    const signature = signWebhook({ id, timestampSec, body, secretKeys: [secret] });
    expect(() =>
      verifySvixSignature(
        { id, timestamp: String(timestampSec), signature },
        body,
        secret,
      ),
    ).not.toThrow();
  });

  it("(b) verifies against the independent `svix` npm package", () => {
    const signature = signWebhook({ id, timestampSec, body, secretKeys: [secret] });
    const wh = new SvixWebhook(secret);
    expect(() =>
      wh.verify(body, {
        "svix-id": id,
        "svix-timestamp": String(timestampSec),
        "svix-signature": signature,
      }),
    ).not.toThrow();
  });

  it("(c) two active secrets produce two space-separated v1, parts, each verifying under its own secret", () => {
    const secretA = generateWebhookSecret();
    const secretB = generateWebhookSecret();
    const signature = signWebhook({
      id,
      timestampSec,
      body,
      secretKeys: [secretA, secretB],
    });

    const parts = signature.split(" ");
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(part.startsWith("v1,")).toBe(true);
    }

    // Verifies under EITHER secret (our verifier tries all v1, candidates).
    expect(() =>
      verifySvixSignature(
        { id, timestamp: String(timestampSec), signature },
        body,
        secretA,
      ),
    ).not.toThrow();
    expect(() =>
      verifySvixSignature(
        { id, timestamp: String(timestampSec), signature },
        body,
        secretB,
      ),
    ).not.toThrow();

    // Independent svix verifier agrees for both secrets too.
    expect(() =>
      new SvixWebhook(secretA).verify(body, {
        "svix-id": id,
        "svix-timestamp": String(timestampSec),
        "svix-signature": signature,
      }),
    ).not.toThrow();
    expect(() =>
      new SvixWebhook(secretB).verify(body, {
        "svix-id": id,
        "svix-timestamp": String(timestampSec),
        "svix-signature": signature,
      }),
    ).not.toThrow();
  });

  // Base64 decoding never throws — an empty or entirely non-base64 secret
  // yields a zero-length key, and HMAC-ing with one produces a signature
  // anyone can reproduce. Fail closed, exactly as the verifier does.
  it.each([
    ["empty after the prefix", `${WEBHOOK_SECRET_PREFIX}`],
    ["empty string", ""],
    ["no base64 characters at all", `${WEBHOOK_SECRET_PREFIX}!!!!`],
  ])("(e) throws on a secret that decodes to zero bytes: %s", (_label, badSecret) => {
    expect(() =>
      signWebhook({ id, timestampSec, body, secretKeys: [badSecret] }),
    ).toThrow(/undecodable/i);
  });

  it("(f) throws when ANY key in the rotation set is undecodable — never signs partially", () => {
    expect(() =>
      signWebhook({
        id,
        timestampSec,
        body,
        secretKeys: [generateWebhookSecret(), WEBHOOK_SECRET_PREFIX],
      }),
    ).toThrow(/undecodable/i);
  });

  it("(d) a tampered body fails BOTH our verifier and the svix verifier", () => {
    const signature = signWebhook({ id, timestampSec, body, secretKeys: [secret] });
    const tamperedBody = JSON.stringify({ hello: "world!!" });

    expect(() =>
      verifySvixSignature(
        { id, timestamp: String(timestampSec), signature },
        tamperedBody,
        secret,
      ),
    ).toThrow();

    const wh = new SvixWebhook(secret);
    expect(() =>
      wh.verify(tamperedBody, {
        "svix-id": id,
        "svix-timestamp": String(timestampSec),
        "svix-signature": signature,
      }),
    ).toThrow();
  });
});
