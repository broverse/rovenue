// =============================================================
// send-push-worker — integration tests (real Postgres + Redis)
// =============================================================
//
// Uses a stub PushTransport per platform; the rest (Postgres,
// Redis, BullMQ) runs against the docker-compose dev stack.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { Queue, type Worker } from "bullmq";
import { Redis } from "ioredis";
import { eq, and } from "drizzle-orm";
import { drizzle, getDb } from "@rovenue/db";
import type {
  PushMessage,
  PushSendOutcome,
  PushTransport,
} from "../lib/push";
import { logger } from "../lib/logger";
import {
  SEND_PUSH_QUEUE_NAME,
  type SendPushJob,
} from "../queues/notifier";
import { startSendPushWorker } from "./send-push-worker";

const db = getDb();
const schema = drizzle.schema;

class StubTransport implements PushTransport {
  sent: PushMessage[] = [];
  /** Outcome to return on the next send(). Mutated per-test. */
  outcome: PushSendOutcome = { ok: true, providerMessageId: "stub-ok" };
  /** Per-token override; falls back to .outcome when a token isn't here. */
  perToken = new Map<string, PushSendOutcome>();

  constructor(public readonly platform: "ios" | "android") {}

  async send(msg: PushMessage): Promise<PushSendOutcome> {
    this.sent.push(msg);
    return this.perToken.get(msg.deviceToken) ?? this.outcome;
  }
}

async function seedDelivery() {
  const userId = createId();
  const now = new Date();
  await db.insert(schema.user).values({
    id: userId,
    name: `u-${userId}`,
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const [notif] = await db
    .insert(schema.notifications)
    .values({
      userId,
      eventKey: "team.member.invited",
      eventId: createId(),
      title: "t",
      body: "b",
    })
    .returning();
  if (!notif) throw new Error("seedDelivery: no notification");
  const [delivery] = await db
    .insert(schema.notificationDeliveries)
    .values({
      notificationId: notif.id,
      channel: "push",
      status: "queued",
    })
    .returning();
  if (!delivery) throw new Error("seedDelivery: no delivery");
  return { userId, deliveryId: delivery.id };
}

async function addDevice(
  userId: string,
  platform: "ios" | "android",
  token: string,
) {
  await db.insert(schema.pushDevices).values({
    userId,
    platform,
    token,
    appBundleId: "io.rovenue.test",
    locale: "en",
    timezone: "UTC",
  });
}

async function readDelivery(id: string) {
  const rows = await db
    .select()
    .from(schema.notificationDeliveries)
    .where(eq(schema.notificationDeliveries.id, id));
  return rows[0];
}

async function readDevice(platform: "ios" | "android", token: string) {
  const rows = await db
    .select()
    .from(schema.pushDevices)
    .where(
      and(
        eq(schema.pushDevices.platform, platform),
        eq(schema.pushDevices.token, token),
      ),
    );
  return rows[0];
}

async function waitForStatus(
  deliveryId: string,
  target: "sent" | "failed",
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await readDelivery(deliveryId);
    if (row?.status === target) return row;
    await new Promise((r) => setTimeout(r, 100));
  }
  const last = await readDelivery(deliveryId);
  throw new Error(
    `delivery ${deliveryId} did not reach ${target} (last=${last?.status})`,
  );
}

describe.sequential("send-push-worker (integration)", () => {
  let connection: Redis;
  let queue: Queue<SendPushJob>;
  let worker: Worker<SendPushJob>;
  let ios: StubTransport;
  let android: StubTransport;

  beforeAll(async () => {
    connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6380", {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });
    await connection.flushdb();
    queue = new Queue<SendPushJob>(SEND_PUSH_QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "fixed", delay: 50 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    });
    ios = new StubTransport("ios");
    android = new StubTransport("android");
    worker = startSendPushWorker({
      connection,
      db,
      transports: { ios, android },
      logger,
      concurrency: 2,
      rateLimit: { max: 50, duration: 1_000 },
    });
    await worker.waitUntilReady();
  });

  beforeEach(() => {
    ios.sent = [];
    android.sent = [];
    ios.outcome = { ok: true, providerMessageId: "ios-ok" };
    android.outcome = { ok: true, providerMessageId: "and-ok" };
    ios.perToken.clear();
    android.perToken.clear();
  });

  afterAll(async () => {
    await worker.close();
    await queue.close();
    connection.disconnect();
  });

  it("single-device success → 'sent' with providerMessageId", async () => {
    const { userId, deliveryId } = await seedDelivery();
    const token = `tok-${createId()}`;
    await addDevice(userId, "ios", token);
    ios.outcome = { ok: true, providerMessageId: "apns-msg-1" };

    await queue.add(
      "send",
      { deliveryId, userId, title: "t", body: "b", data: {} },
      { jobId: deliveryId },
    );

    const row = await waitForStatus(deliveryId, "sent");
    expect(row.providerMessageId).toBe("apns-msg-1");
    expect(ios.sent).toHaveLength(1);
    expect(ios.sent[0]?.deviceToken).toBe(token);
  });

  it("multi-device first-success-wins", async () => {
    const { userId, deliveryId } = await seedDelivery();
    const badToken = `tok-${createId()}`;
    const goodToken = `tok-${createId()}`;
    await addDevice(userId, "android", badToken);
    await addDevice(userId, "ios", goodToken);
    android.perToken.set(badToken, {
      ok: false,
      error: "InvalidRegistration",
      permanent: true,
    });
    ios.perToken.set(goodToken, {
      ok: true,
      providerMessageId: "apns-msg-2",
    });

    await queue.add(
      "send",
      { deliveryId, userId, title: "t", body: "b", data: {} },
      { jobId: deliveryId },
    );

    const row = await waitForStatus(deliveryId, "sent");
    expect(row.providerMessageId).toBe("apns-msg-2");
    // Permanent-fail token got revoked.
    const dev = await readDevice("android", badToken);
    expect(dev?.revokedAt).not.toBeNull();
  });

  it("no active devices → 'failed' (UnrecoverableError, no retry)", async () => {
    const { userId, deliveryId } = await seedDelivery();
    // No addDevice() — user has zero tokens.

    await queue.add(
      "send",
      { deliveryId, userId, title: "t", body: "b", data: {} },
      { jobId: deliveryId },
    );

    const row = await waitForStatus(deliveryId, "failed");
    expect(row.providerResponse).toMatchObject({ reason: "no_active_devices" });
  });

  it("all devices permanent-fail → 'failed' + tokens revoked", async () => {
    const { userId, deliveryId } = await seedDelivery();
    const t1 = `tok-${createId()}`;
    const t2 = `tok-${createId()}`;
    await addDevice(userId, "ios", t1);
    await addDevice(userId, "android", t2);
    ios.perToken.set(t1, { ok: false, error: "Unregistered", permanent: true });
    android.perToken.set(t2, {
      ok: false,
      error: "NotRegistered",
      permanent: true,
    });

    await queue.add(
      "send",
      { deliveryId, userId, title: "t", body: "b", data: {} },
      { jobId: deliveryId },
    );

    const row = await waitForStatus(deliveryId, "failed");
    expect((await readDevice("ios", t1))?.revokedAt).not.toBeNull();
    expect((await readDevice("android", t2))?.revokedAt).not.toBeNull();
    const summary = (row.providerResponse as { devices: Array<{ ok: boolean }> })
      .devices;
    expect(summary.every((d) => !d.ok)).toBe(true);
  });

  it("transient failure retries and eventually succeeds", async () => {
    const { userId, deliveryId } = await seedDelivery();
    const token = `tok-${createId()}`;
    await addDevice(userId, "ios", token);

    let calls = 0;
    const origSend = ios.send.bind(ios);
    ios.send = async (msg) => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, error: "503", permanent: false };
      }
      return origSend(msg);
    };
    ios.outcome = { ok: true, providerMessageId: "apns-retry-ok" };

    await queue.add(
      "send",
      { deliveryId, userId, title: "t", body: "b", data: {} },
      { jobId: deliveryId },
    );

    const row = await waitForStatus(deliveryId, "sent");
    expect(row.providerMessageId).toBe("apns-retry-ok");
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
