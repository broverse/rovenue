import { describe, expect, it } from "vitest";
import {
  signUnsubscribeToken,
  UnsubscribeTokenError,
  verifyUnsubscribeToken,
} from "./unsubscribe-token";

const KEY_A = "00".repeat(32); // 32-byte hex
const KEY_B = "11".repeat(32);
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;

describe("unsubscribe token", () => {
  it("round-trips a payload with the same signing key", () => {
    const token = signUnsubscribeToken(
      { userId: "u1", scope: "channel:email", exp: FAR_FUTURE },
      KEY_A,
    );
    const verified = verifyUnsubscribeToken(token, KEY_A);
    expect(verified.userId).toBe("u1");
    expect(verified.scope).toBe("channel:email");
    expect(verified.exp).toBe(FAR_FUTURE);
  });

  it("preserves event-scope and projectId", () => {
    const token = signUnsubscribeToken(
      {
        userId: "u1",
        scope: "event:revenue.anomaly.detected",
        projectId: "p1",
        exp: FAR_FUTURE,
      },
      KEY_A,
    );
    const verified = verifyUnsubscribeToken(token, KEY_A);
    expect(verified.scope).toBe("event:revenue.anomaly.detected");
    expect(verified.projectId).toBe("p1");
  });

  it("rejects tokens signed with a different key", () => {
    const token = signUnsubscribeToken(
      { userId: "u1", scope: "channel:email", exp: FAR_FUTURE },
      KEY_A,
    );
    expect(() => verifyUnsubscribeToken(token, KEY_B)).toThrow(
      UnsubscribeTokenError,
    );
    try {
      verifyUnsubscribeToken(token, KEY_B);
    } catch (e) {
      expect((e as UnsubscribeTokenError).code).toBe("invalid_signature");
    }
  });

  it("rejects tokens whose body has been tampered with", () => {
    const token = signUnsubscribeToken(
      { userId: "u1", scope: "channel:email", exp: FAR_FUTURE },
      KEY_A,
    );
    const [, sig] = token.split(".");
    const tampered = `${Buffer.from('{"userId":"u-evil","scope":"channel:email","exp":${FAR_FUTURE}}').toString("base64url")}.${sig}`;
    expect(() => verifyUnsubscribeToken(tampered, KEY_A)).toThrow(
      /invalid unsubscribe signature|malformed/,
    );
  });

  it("rejects expired tokens", () => {
    const token = signUnsubscribeToken(
      { userId: "u1", scope: "channel:email", exp: 1000 },
      KEY_A,
    );
    expect(() => verifyUnsubscribeToken(token, KEY_A)).toThrow(/expired/);
    try {
      verifyUnsubscribeToken(token, KEY_A);
    } catch (e) {
      expect((e as UnsubscribeTokenError).code).toBe("expired");
    }
  });

  it("rejects malformed tokens", () => {
    expect(() => verifyUnsubscribeToken("not-a-token", KEY_A)).toThrow(
      /malformed/,
    );
    expect(() => verifyUnsubscribeToken("abc.def.ghi", KEY_A)).toThrow(
      /malformed/,
    );
    expect(() => verifyUnsubscribeToken(".sig", KEY_A)).toThrow(/malformed/);
  });
});
