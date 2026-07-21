// =============================================================
// Resend events route — unit tests
//
// No real Postgres, Redis, or Resend dependency.
// - signature verification is ON (real HMACs computed in-test)
// - svix-id dedup short-circuits replays
// - suppression + master-switch side effects on bounce/complaint
// =============================================================

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Env must be seeded before lib/env is imported (and static imports are
// hoisted above ordinary statements), so run this via vi.hoisted — vitest
// lifts it above the import execution alongside the vi.mock factories.
vi.hoisted(() => {
  process.env.RESEND_EVENTS_VERIFY_SIGNATURE = "true";
  process.env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from("route-test-key").toString("base64")}`;
  process.env.NODE_ENV = "test";
  process.env.REDIS_URL = "redis://localhost:6379";
});

vi.mock("../../lib/redis", () => ({
  redis: {
    set: vi.fn(),
  },
}));

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: {},
      invitationRepo: {
        setDeliveryStatus: vi.fn().mockResolvedValue(undefined),
      },
      notificationDeliveryRepo: {
        findDeliveryByProviderMessageId: vi.fn().mockResolvedValue(null),
        markDeliveryStatus: vi.fn().mockResolvedValue(undefined),
      },
      notificationSuppressionRepo: {
        add: vi.fn().mockResolvedValue(undefined),
      },
      notificationPreferencesRepo: {
        updateUserChannels: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
});

import { redis } from "../../lib/redis";
import { drizzle } from "@rovenue/db";
import { resendEventsRoute } from "./resend-events";

const redisMock = redis as unknown as { set: ReturnType<typeof vi.fn> };
const drizzleMock = drizzle as unknown as {
  invitationRepo: { setDeliveryStatus: ReturnType<typeof vi.fn> };
  notificationDeliveryRepo: {
    findDeliveryByProviderMessageId: ReturnType<typeof vi.fn>;
    markDeliveryStatus: ReturnType<typeof vi.fn>;
  };
  notificationSuppressionRepo: { add: ReturnType<typeof vi.fn> };
  notificationPreferencesRepo: { updateUserChannels: ReturnType<typeof vi.fn> };
};

const KEY = Buffer.from("route-test-key");

function signedRequest(body: string, overrides: Partial<Record<string, string>> = {}) {
  const id = overrides["svix-id"] ?? "msg_1";
  const timestamp = overrides["svix-timestamp"] ?? String(Math.floor(Date.now() / 1000));
  const signature =
    overrides["svix-signature"] ??
    `v1,${createHmac("sha256", KEY).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
  return new Request("http://localhost/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": signature,
    },
    body,
  });
}

function deliveredBody(emailId = "re_1"): string {
  return JSON.stringify({
    type: "email.delivered",
    data: { email_id: emailId, to: ["user@example.com"] },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.set.mockResolvedValue("OK");
  drizzleMock.notificationDeliveryRepo.findDeliveryByProviderMessageId.mockResolvedValue(null);
});

describe("resend-events route", () => {
  it("rejects a request with a bad signature", async () => {
    const res = await resendEventsRoute.request(
      signedRequest(deliveredBody(), { "svix-signature": "v1,AAAA" }),
    );
    expect(res.status).toBe(403);
    expect(drizzleMock.invitationRepo.setDeliveryStatus).not.toHaveBeenCalled();
  });

  it("accepts a validly signed delivery and patches invitation status", async () => {
    const res = await resendEventsRoute.request(signedRequest(deliveredBody()));
    expect(res.status).toBe(200);
    expect(drizzleMock.invitationRepo.setDeliveryStatus).toHaveBeenCalledWith(
      expect.anything(),
      "re_1",
      "DELIVERED",
      null,
    );
  });

  it("dedups a replayed svix-id without reprocessing", async () => {
    redisMock.set.mockResolvedValue(null); // NX miss → already seen
    const res = await resendEventsRoute.request(signedRequest(deliveredBody()));
    expect(res.status).toBe(200);
    expect(drizzleMock.invitationRepo.setDeliveryStatus).not.toHaveBeenCalled();
  });

  it("fails open when redis errors", async () => {
    redisMock.set.mockRejectedValue(new Error("redis down"));
    const res = await resendEventsRoute.request(signedRequest(deliveredBody()));
    expect(res.status).toBe(200);
    expect(drizzleMock.invitationRepo.setDeliveryStatus).toHaveBeenCalled();
  });

  it("bounce suppresses recipients and marks the delivery bounced", async () => {
    drizzleMock.notificationDeliveryRepo.findDeliveryByProviderMessageId.mockResolvedValue({
      id: "del_1",
      notificationId: "not_1",
    });
    const body = JSON.stringify({
      type: "email.bounced",
      data: {
        email_id: "re_2",
        to: ["Bounced@Example.com"],
        bounce: { type: "Permanent", subType: "General", message: "550" },
      },
    });
    const res = await resendEventsRoute.request(signedRequest(body));
    expect(res.status).toBe(200);
    expect(drizzleMock.notificationSuppressionRepo.add).toHaveBeenCalledWith(
      expect.anything(),
      { email: "bounced@example.com", reason: "hard_bounce", source: "resend" },
    );
    expect(drizzleMock.notificationDeliveryRepo.markDeliveryStatus).toHaveBeenCalledWith(
      expect.anything(),
      "del_1",
      "bounced",
      expect.objectContaining({ providerResponse: expect.anything() }),
    );
  });

  it("complaint suppresses the recipient with reason complaint", async () => {
    const body = JSON.stringify({
      type: "email.complained",
      data: { email_id: "re_3", to: ["angry@example.com"] },
    });
    const res = await resendEventsRoute.request(signedRequest(body));
    expect(res.status).toBe(200);
    expect(drizzleMock.notificationSuppressionRepo.add).toHaveBeenCalledWith(
      expect.anything(),
      { email: "angry@example.com", reason: "complaint", source: "resend" },
    );
  });

  it("ignores non-delivery events with a 200", async () => {
    const body = JSON.stringify({
      type: "email.opened",
      data: { email_id: "re_4", to: ["user@example.com"] },
    });
    const res = await resendEventsRoute.request(signedRequest(body));
    expect(res.status).toBe(200);
    expect(drizzleMock.invitationRepo.setDeliveryStatus).not.toHaveBeenCalled();
  });
});
