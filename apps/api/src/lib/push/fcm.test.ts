import { describe, expect, it, vi } from "vitest";
import {
  FcmPushTransport,
  classifyFcmResponse,
  type FcmHttpResponse,
  type FcmHttpSend,
} from "./fcm";

const SA_JSON = JSON.stringify({
  project_id: "rovenue-dev",
  client_email: "fcm@rovenue-dev.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
});

const baseMsg = {
  deviceToken: "android-token",
  title: "Hi",
  body: "msg",
  data: { url: "/x" },
};

function mockSender(res: FcmHttpResponse) {
  return vi
    .fn<[Parameters<FcmHttpSend>[0]], ReturnType<FcmHttpSend>>()
    .mockResolvedValue(res);
}

describe("FcmPushTransport", () => {
  it("returns ok on 200, using `name` as providerMessageId", async () => {
    const sender = mockSender({
      statusCode: 200,
      body: JSON.stringify({
        name: "projects/rovenue-dev/messages/0:1234",
      }),
    });
    const t = new FcmPushTransport(
      { serviceAccountJson: SA_JSON },
      async () => "tok",
      sender,
    );
    const r = await t.send(baseMsg);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.providerMessageId).toBe("projects/rovenue-dev/messages/0:1234");
  });

  it("posts to fcm.googleapis.com/v1/projects/<id>/messages:send with bearer token", async () => {
    const sender = mockSender({
      statusCode: 200,
      body: JSON.stringify({ name: "id" }),
    });
    const t = new FcmPushTransport(
      { serviceAccountJson: SA_JSON },
      async () => "tok",
      sender,
    );
    await t.send({ ...baseMsg, collapseKey: "anomaly-p1" });
    expect(sender).toHaveBeenCalledTimes(1);
    const req = sender.mock.calls[0]![0];
    expect(req.url).toBe(
      "https://fcm.googleapis.com/v1/projects/rovenue-dev/messages:send",
    );
    expect(req.accessToken).toBe("tok");
    const parsed = JSON.parse(req.body) as {
      message: {
        token: string;
        notification: { title: string; body: string };
        data: Record<string, string>;
        android?: { collapse_key?: string };
      };
    };
    expect(parsed.message.token).toBe("android-token");
    expect(parsed.message.notification).toEqual({ title: "Hi", body: "msg" });
    expect(parsed.message.data).toEqual({ url: "/x" });
    expect(parsed.message.android?.collapse_key).toBe("anomaly-p1");
  });

  it("returns transient failure when the token provider throws", async () => {
    const sender = mockSender({ statusCode: 200, body: "{}" });
    const t = new FcmPushTransport(
      { serviceAccountJson: SA_JSON },
      async () => {
        throw new Error("auth_broken");
      },
      sender,
    );
    const r = await t.send(baseMsg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.permanent).toBe(false);
      expect(r.error).toBe("auth_broken");
    }
    expect(sender).not.toHaveBeenCalled();
  });

  it("marks UNREGISTERED as permanent", async () => {
    const sender = mockSender({
      statusCode: 404,
      body: JSON.stringify({
        error: {
          status: "NOT_FOUND",
          details: [
            {
              "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
              errorCode: "UNREGISTERED",
            },
          ],
        },
      }),
    });
    const t = new FcmPushTransport(
      { serviceAccountJson: SA_JSON },
      async () => "tok",
      sender,
    );
    const r = await t.send(baseMsg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.permanent).toBe(true);
      expect(r.error).toBe("UNREGISTERED");
    }
  });

  it("marks SENDER_ID_MISMATCH as permanent (even outside 404)", async () => {
    const sender = mockSender({
      statusCode: 403,
      body: JSON.stringify({
        error: {
          status: "PERMISSION_DENIED",
          details: [
            {
              "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
              errorCode: "SENDER_ID_MISMATCH",
            },
          ],
        },
      }),
    });
    const t = new FcmPushTransport(
      { serviceAccountJson: SA_JSON },
      async () => "tok",
      sender,
    );
    const r = await t.send(baseMsg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.permanent).toBe(true);
  });

  it("treats 503 / UNAVAILABLE as transient", async () => {
    const sender = mockSender({
      statusCode: 503,
      body: JSON.stringify({ error: { status: "UNAVAILABLE" } }),
    });
    const t = new FcmPushTransport(
      { serviceAccountJson: SA_JSON },
      async () => "tok",
      sender,
    );
    const r = await t.send(baseMsg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.permanent).toBe(false);
      expect(r.error).toBe("UNAVAILABLE");
    }
  });

  it("throws at construction when the service account JSON is invalid", () => {
    expect(() => new FcmPushTransport({ serviceAccountJson: "{}" })).toThrow(
      /missing project_id/,
    );
  });
});

describe("classifyFcmResponse (raw)", () => {
  it("non-JSON 200 body still returns ok with empty providerMessageId", () => {
    const r = classifyFcmResponse({ statusCode: 200, body: "not json" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.providerMessageId).toBe("");
  });

  it("fallback error label uses HTTP status when no errorCode is present", () => {
    const r = classifyFcmResponse({ statusCode: 500, body: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("fcm_http_500");
      expect(r.permanent).toBe(false);
    }
  });
});
