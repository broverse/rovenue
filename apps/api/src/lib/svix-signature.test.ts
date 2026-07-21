import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySvixSignature } from "./svix-signature";

const KEY = Buffer.from("test-secret-key-material");
const SECRET = `whsec_${KEY.toString("base64")}`;
const BODY = '{"type":"email.delivered"}';

function sign(id: string, timestamp: string, body: string): string {
  return createHmac("sha256", KEY).update(`${id}.${timestamp}.${body}`).digest("base64");
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

describe("verifySvixSignature", () => {
  it("accepts a valid signature", () => {
    const ts = String(nowSec());
    const sig = sign("msg_1", ts, BODY);
    expect(() =>
      verifySvixSignature(
        { id: "msg_1", timestamp: ts, signature: `v1,${sig}` },
        BODY,
        SECRET,
      ),
    ).not.toThrow();
  });

  it("accepts when only the second of multiple v1 entries matches", () => {
    const ts = String(nowSec());
    const good = sign("msg_1", ts, BODY);
    const bad = sign("msg_other", ts, BODY);
    expect(() =>
      verifySvixSignature(
        { id: "msg_1", timestamp: ts, signature: `v1,${bad} v1,${good}` },
        BODY,
        SECRET,
      ),
    ).not.toThrow();
  });

  it("rejects a tampered body", () => {
    const ts = String(nowSec());
    const sig = sign("msg_1", ts, BODY);
    expect(() =>
      verifySvixSignature(
        { id: "msg_1", timestamp: ts, signature: `v1,${sig}` },
        '{"type":"email.bounced"}',
        SECRET,
      ),
    ).toThrow(/no matching/);
  });

  it("rejects a timestamp outside the 5-minute tolerance", () => {
    const stale = String(nowSec() - 6 * 60);
    const sig = sign("msg_1", stale, BODY);
    expect(() =>
      verifySvixSignature(
        { id: "msg_1", timestamp: stale, signature: `v1,${sig}` },
        BODY,
        SECRET,
      ),
    ).toThrow(/tolerance/);
  });

  it("rejects missing headers", () => {
    expect(() =>
      verifySvixSignature(
        { id: undefined, timestamp: String(nowSec()), signature: "v1,x" },
        BODY,
        SECRET,
      ),
    ).toThrow(/missing/);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(() =>
      verifySvixSignature(
        { id: "msg_1", timestamp: "not-a-number", signature: "v1,x" },
        BODY,
        SECRET,
      ),
    ).toThrow(/timestamp/);
  });

  it("rejects an empty/undecodable secret", () => {
    const ts = String(nowSec());
    expect(() =>
      verifySvixSignature(
        { id: "msg_1", timestamp: ts, signature: "v1,x" },
        BODY,
        "whsec_",
      ),
    ).toThrow(/secret/);
  });
});
