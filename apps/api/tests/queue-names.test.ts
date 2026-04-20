import { describe, expect, test, vi } from "vitest";

// BullMQ 5+ hard-rejects queue names that contain `:` because the colon
// is its internal Redis-key delimiter (`QueueBase` throws at construction
// time). We used to prefix with "rovenue:…"; this test is the regression
// guard that prevents re-introducing that pattern.
//
// Each of the four queue-owning modules pulls prisma + ioredis + env via
// side-effect imports. Mock them so the constants can be loaded without
// spinning up real connections.

vi.mock("@rovenue/db", () => ({
  default: {},
  OutgoingWebhookStatus: {},
  PurchaseStatus: {},
  RevenueEventType: {},
  Store: {},
  WebhookEventStatus: {},
  WebhookSource: {},
}));
vi.mock("../src/lib/redis", () => ({ redis: {} }));

import { DELIVERY_QUEUE_NAME } from "../src/workers/webhook-delivery";
import { EXPIRY_QUEUE_NAME } from "../src/workers/expiry-checker";
import { FX_QUEUE_NAME } from "../src/services/fx";
import { WEBHOOK_QUEUE_NAME } from "../src/services/webhook-processor";

describe("BullMQ queue names", () => {
  test.each([
    ["DELIVERY_QUEUE_NAME", DELIVERY_QUEUE_NAME],
    ["EXPIRY_QUEUE_NAME", EXPIRY_QUEUE_NAME],
    ["FX_QUEUE_NAME", FX_QUEUE_NAME],
    ["WEBHOOK_QUEUE_NAME", WEBHOOK_QUEUE_NAME],
  ])("%s must not contain ':' (BullMQ rejects)", (_name, value) => {
    expect(value).not.toContain(":");
  });

  test("all queue names are rovenue-prefixed for namespace isolation", () => {
    expect(DELIVERY_QUEUE_NAME).toMatch(/^rovenue-/);
    expect(EXPIRY_QUEUE_NAME).toMatch(/^rovenue-/);
    expect(FX_QUEUE_NAME).toMatch(/^rovenue-/);
    expect(WEBHOOK_QUEUE_NAME).toMatch(/^rovenue-/);
  });

  test("all queue names are unique", () => {
    const names = [
      DELIVERY_QUEUE_NAME,
      EXPIRY_QUEUE_NAME,
      FX_QUEUE_NAME,
      WEBHOOK_QUEUE_NAME,
    ];
    expect(new Set(names).size).toBe(names.length);
  });
});
