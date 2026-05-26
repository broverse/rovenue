import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { decodeJwt, decodeProtectedHeader } from "jose";
import {
  ApnsPushTransport,
  classifyApnsResponse,
  type ApnsConfig,
  type ApnsHttp2Response,
  type ApnsHttp2Send,
} from "./apns";

function testKeyP8(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

function configWith(overrides: Partial<ApnsConfig> = {}): ApnsConfig {
  return {
    keyId: "ABC123KEYID",
    teamId: "TEAM4567",
    keyP8: testKeyP8(),
    bundleId: "io.rovenue.app",
    environment: "sandbox",
    ...overrides,
  };
}

const baseMsg = {
  deviceToken: "abcd1234",
  title: "Hi",
  body: "msg",
  data: { url: "/x" },
};

describe("ApnsPushTransport", () => {
  it("returns ok on 200 with apns-id header", async () => {
    const sender = vi.fn<[Parameters<ApnsHttp2Send>[0]], ReturnType<ApnsHttp2Send>>().mockResolvedValue({
      statusCode: 200,
      headers: { "apns-id": "abc-123" },
      body: "",
    });
    const t = new ApnsPushTransport(configWith(), sender);
    const r = await t.send(baseMsg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.providerMessageId).toBe("abc-123");
  });

  it("posts to /3/device/<token> with the right APNs headers", async () => {
    const sender = vi.fn<[Parameters<ApnsHttp2Send>[0]], ReturnType<ApnsHttp2Send>>().mockResolvedValue({
      statusCode: 200,
      headers: { "apns-id": "id" },
      body: "",
    });
    const t = new ApnsPushTransport(configWith(), sender);
    await t.send({ ...baseMsg, threadId: "thr_1", badge: 5, collapseKey: "cl-1" });
    expect(sender).toHaveBeenCalledTimes(1);
    const req = sender.mock.calls[0]![0];
    expect(req.path).toBe("/3/device/abcd1234");
    expect(req.headers["apns-topic"]).toBe("io.rovenue.app");
    expect(req.headers["apns-push-type"]).toBe("alert");
    expect(req.headers["apns-priority"]).toBe("10");
    expect(req.headers["apns-collapse-id"]).toBe("cl-1");
    expect(req.headers.authorization).toMatch(/^bearer /);

    const parsed = JSON.parse(req.body) as {
      aps: {
        alert: { title: string; body: string };
        "thread-id"?: string;
        badge?: number;
        "mutable-content"?: number;
      };
      data: Record<string, string>;
    };
    expect(parsed.aps.alert).toEqual({ title: "Hi", body: "msg" });
    expect(parsed.aps["thread-id"]).toBe("thr_1");
    expect(parsed.aps.badge).toBe(5);
    expect(parsed.aps["mutable-content"]).toBe(1);
    expect(parsed.data).toEqual({ url: "/x" });
  });

  it("signs the JWT with kid=keyId, iss=teamId, alg=ES256", async () => {
    const sender = vi.fn<[Parameters<ApnsHttp2Send>[0]], ReturnType<ApnsHttp2Send>>().mockResolvedValue({
      statusCode: 200,
      headers: { "apns-id": "id" },
      body: "",
    });
    const cfg = configWith({ keyId: "KEY_X", teamId: "TEAM_Y" });
    const t = new ApnsPushTransport(cfg, sender);
    await t.send(baseMsg);
    const jwt = (sender.mock.calls[0]![0].headers.authorization ?? "").replace(
      /^bearer /,
      "",
    );
    expect(decodeProtectedHeader(jwt)).toMatchObject({
      alg: "ES256",
      kid: "KEY_X",
    });
    expect(decodeJwt(jwt).iss).toBe("TEAM_Y");
  });

  it("caches the JWT across sends within the TTL window", async () => {
    const sender = vi.fn<[Parameters<ApnsHttp2Send>[0]], ReturnType<ApnsHttp2Send>>().mockResolvedValue({
      statusCode: 200,
      headers: { "apns-id": "id" },
      body: "",
    });
    let now = 1_700_000_000_000;
    const t = new ApnsPushTransport(configWith(), sender, () => now);
    await t.send(baseMsg);
    const jwt1 = sender.mock.calls[0]![0].headers.authorization;
    now += 60_000; // 1 minute later
    await t.send(baseMsg);
    const jwt2 = sender.mock.calls[1]![0].headers.authorization;
    expect(jwt1).toBe(jwt2);
    now += 50 * 60 * 1000; // beyond TTL
    await t.send(baseMsg);
    const jwt3 = sender.mock.calls[2]![0].headers.authorization;
    expect(jwt3).not.toBe(jwt1);
  });

  it("marks 400 + BadDeviceToken as permanent", async () => {
    const sender = vi.fn<[Parameters<ApnsHttp2Send>[0]], ReturnType<ApnsHttp2Send>>().mockResolvedValue({
      statusCode: 400,
      headers: {},
      body: JSON.stringify({ reason: "BadDeviceToken" }),
    });
    const t = new ApnsPushTransport(configWith(), sender);
    const r = await t.send(baseMsg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.permanent).toBe(true);
      expect(r.error).toBe("BadDeviceToken");
    }
  });

  it("marks 410 Gone as permanent", async () => {
    const sender = vi.fn<[Parameters<ApnsHttp2Send>[0]], ReturnType<ApnsHttp2Send>>().mockResolvedValue({
      statusCode: 410,
      headers: {},
      body: JSON.stringify({ reason: "Unregistered" }),
    });
    const t = new ApnsPushTransport(configWith(), sender);
    const r = await t.send(baseMsg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.permanent).toBe(true);
  });

  it("treats 5xx as transient", async () => {
    const sender = vi.fn<[Parameters<ApnsHttp2Send>[0]], ReturnType<ApnsHttp2Send>>().mockResolvedValue({
      statusCode: 503,
      headers: {},
      body: "",
    });
    const t = new ApnsPushTransport(configWith(), sender);
    const r = await t.send(baseMsg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.permanent).toBe(false);
  });

  it("treats 429 as transient", async () => {
    const sender = vi.fn<[Parameters<ApnsHttp2Send>[0]], ReturnType<ApnsHttp2Send>>().mockResolvedValue({
      statusCode: 429,
      headers: {},
      body: JSON.stringify({ reason: "TooManyRequests" }),
    });
    const t = new ApnsPushTransport(configWith(), sender);
    const r = await t.send(baseMsg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.permanent).toBe(false);
      expect(r.error).toBe("TooManyRequests");
    }
  });

  it("returns transient failure when sender throws", async () => {
    const sender = vi
      .fn<[Parameters<ApnsHttp2Send>[0]], ReturnType<ApnsHttp2Send>>()
      .mockRejectedValue(new Error("ECONNRESET"));
    const t = new ApnsPushTransport(configWith(), sender);
    const r = await t.send(baseMsg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.permanent).toBe(false);
      expect(r.error).toBe("ECONNRESET");
    }
  });
});

describe("classifyApnsResponse (raw)", () => {
  function res(over: Partial<ApnsHttp2Response>): ApnsHttp2Response {
    return { statusCode: 200, headers: {}, body: "", ...over };
  }

  it("400 + reason not in permanent set → transient", () => {
    const r = classifyApnsResponse(
      res({ statusCode: 400, body: JSON.stringify({ reason: "PayloadTooLarge" }) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.permanent).toBe(false);
      expect(r.error).toBe("PayloadTooLarge");
    }
  });

  it("non-JSON 400 body → transient with apns_http_400", () => {
    const r = classifyApnsResponse(res({ statusCode: 400, body: "not json" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("apns_http_400");
  });
});
