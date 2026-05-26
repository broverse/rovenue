// =============================================================
// requireSnsSignature middleware — unit tests
// =============================================================
//
// Doesn't actually fetch an AWS cert — we stub global.fetch with
// a PEM + use a pre-signed canonicalised payload so the cert
// host check and signature verification both pass. The "happy
// path" trade-off is that we generate the signature in the test
// with a local key and have verifySnsSignature trust the same
// key via the stubbed fetch; the canonical algorithm under test
// is real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, createSign } from "node:crypto";
import { Hono } from "hono";
import { requireSnsSignature } from "./sns-signature";

interface SnsBody {
  Type: "Notification" | "SubscriptionConfirmation";
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Token?: string;
  SubscribeURL?: string;
}

// canonical string-to-sign mirroring lib/sns-signature.ts
function canonicalize(p: SnsBody): string {
  const keys =
    p.Type === "Notification"
      ? (["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] as const)
      : (["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"] as const);
  const lines: string[] = [];
  for (const k of keys) {
    const v = (p as unknown as Record<string, string | undefined>)[k];
    if (v == null) continue;
    lines.push(k);
    lines.push(String(v));
  }
  return lines.join("\n") + "\n";
}

function buildSignedNotification(privPem: string, signingCertURL: string): SnsBody {
  const unsigned: SnsBody = {
    Type: "Notification",
    MessageId: "msg-1",
    TopicArn: "arn:aws:sns:us-east-1:111:topic",
    Subject: "test",
    Message: '{"notificationType":"Bounce"}',
    Timestamp: "2026-05-26T00:00:00.000Z",
    SignatureVersion: "1",
    Signature: "", // filled below
    SigningCertURL: signingCertURL,
  };
  const signer = createSign("RSA-SHA1");
  signer.update(canonicalize(unsigned));
  signer.end();
  unsigned.Signature = signer.sign(privPem, "base64");
  return unsigned;
}

describe("requireSnsSignature middleware", () => {
  let pubPem: string;
  let privPem: string;
  // vi.spyOn(global, "fetch") returns a richly-typed mock that
  // doesn't unify with `ReturnType<typeof vi.spyOn>` — use the
  // looser `any` here, since the test only uses .mockImplementation
  // and .mockRestore which both exist on every spy variant.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    pubPem = pair.publicKey;
    privPem = pair.privateKey;

    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        new Response(pubPem, { status: 200 }),
      );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function buildApp() {
    const app = new Hono();
    app.post("/sns", requireSnsSignature, (c) => {
      const msg = c.get("snsMessage");
      return c.json({ ok: true, messageId: msg?.MessageId });
    });
    return app;
  }

  it("happy path: valid signature → handler sees snsMessage", async () => {
    const body = buildSignedNotification(
      privPem,
      "https://sns.us-east-1.amazonaws.com/sns.pem",
    );
    const res = await buildApp().request("/sns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, messageId: "msg-1" });
  });

  it("untrusted SigningCertURL host → 400 (cert not fetched)", async () => {
    const body = buildSignedNotification(
      privPem,
      "https://attacker.example.com/sns.pem",
    );
    const res = await buildApp().request("/sns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("tampered Signature → 401", async () => {
    const body = buildSignedNotification(
      privPem,
      "https://sns.us-east-1.amazonaws.com/sns.pem",
    );
    body.Signature = body.Signature.replace(/[Aa]/g, "B");
    const res = await buildApp().request("/sns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(401);
  });

  it("non-SNS body → 400", async () => {
    const res = await buildApp().request("/sns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(res.status).toBe(400);
  });

  it("malformed JSON → 400", async () => {
    const res = await buildApp().request("/sns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
  });
});
