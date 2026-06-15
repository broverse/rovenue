// =============================================================
// send-email-worker — integration tests (real Postgres + Redis)
// =============================================================
//
// Exercises the BullMQ worker against the docker-compose Redis
// (host 6380) and Postgres (host 5433). A Mailer stub captures
// sends and can be flipped to throw on demand so the BullMQ
// retry path can be observed end-to-end.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { Queue, type Worker } from "bullmq";
import { Redis } from "ioredis";
import { drizzle, getDb } from "@rovenue/db";
import type { Mailer, MailMessage } from "../lib/mailer";
import { logger } from "../lib/logger";
import {
  SEND_EMAIL_QUEUE_NAME,
  type SendEmailJob,
} from "../queues/notifier";
import { startSendEmailWorker } from "./send-email-worker";

const db = getDb();
const schema = drizzle.schema;

class StubMailer implements Mailer {
  sent: MailMessage[] = [];
  /** When non-null, send() throws this error and records the attempt. */
  failWith: Error | null = null;
  /** Decrement-on-throw — once it hits 0, send() succeeds. */
  failureBudget = 0;
  /** Custom messageId per call (defaults to ses-<cuid>). */
  messageId: string | null = null;

  async send(msg: MailMessage) {
    this.sent.push(msg);
    if (this.failWith && this.failureBudget > 0) {
      this.failureBudget -= 1;
      throw this.failWith;
    }
    return { messageId: this.messageId ?? `ses-${createId()}` };
  }
}

async function seedDelivery(opts: { email?: string } = {}) {
  const userId = createId();
  const now = new Date();
  await db.insert(schema.user).values({
    id: userId,
    name: `u-${userId}`,
    email: opts.email ?? `${userId}@example.test`,
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
      title: "test",
      body: "body",
    })
    .returning();
  if (!notif) throw new Error("seedDelivery: no notification");

  const [delivery] = await db
    .insert(schema.notificationDeliveries)
    .values({
      notificationId: notif.id,
      channel: "email",
      status: "queued",
    })
    .returning();
  if (!delivery) throw new Error("seedDelivery: no delivery");

  return { userId, deliveryId: delivery.id, email: opts.email ?? `${userId}@example.test` };
}

async function waitForStatus(
  deliveryId: string,
  target: "sent" | "failed" | "suppressed",
  timeoutMs = 8_000,
): Promise<NonNullable<Awaited<ReturnType<typeof readDelivery>>>> {
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

async function readDelivery(id: string) {
  const rows = await db
    .select()
    .from(schema.notificationDeliveries)
    .where(eqRow(schema.notificationDeliveries.id, id));
  return rows[0];
}

import { eq as eqRow } from "drizzle-orm";

describe.sequential("send-email-worker (integration)", () => {
  let connection: Redis;
  let queue: Queue<SendEmailJob>;
  let worker: Worker<SendEmailJob>;
  let mailer: StubMailer;

  beforeAll(async () => {
    connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6380", {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });
    await connection.flushdb();
    queue = new Queue<SendEmailJob>(SEND_EMAIL_QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        // Short backoff keeps the retry test fast; production uses 5s.
        attempts: 2,
        backoff: { type: "fixed", delay: 50 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    });
    mailer = new StubMailer();
    worker = startSendEmailWorker({
      connection,
      db,
      mailer,
      logger,
      concurrency: 2,
      rateLimit: { max: 50, duration: 1_000 },
    });
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker.close();
    await queue.close();
    connection.disconnect();
  });

  it("success → delivery row goes to 'sent' with providerMessageId", async () => {
    mailer.failWith = null;
    mailer.failureBudget = 0;
    mailer.messageId = "ses-success-1";
    const { deliveryId, email } = await seedDelivery();

    await queue.add(
      "send",
      {
        deliveryId,
        to: email,
        headers: { "List-Unsubscribe": "<https://test/u>" },
        subject: "hi",
        html: "<p>hi</p>",
        text: "hi",
      },
      { jobId: deliveryId },
    );

    const row = await waitForStatus(deliveryId, "sent");
    expect(row.providerMessageId).toBe("ses-success-1");
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe(email);
  });

  it("suppressed address → 'suppressed' without invoking mailer", async () => {
    const before = mailer.sent.length;
    const { deliveryId, email } = await seedDelivery();
    await drizzle.notificationSuppressionRepo.add(db, {
      email,
      reason: "manual",
      source: "test",
    });

    await queue.add(
      "send",
      {
        deliveryId,
        to: email,
        headers: {},
        subject: "hi",
        html: "<p>hi</p>",
        text: "hi",
      },
      { jobId: deliveryId },
    );

    const row = await waitForStatus(deliveryId, "suppressed");
    expect(row.providerResponse).toMatchObject({ reason: "suppressed_list" });
    expect(mailer.sent.length).toBe(before);
  });

  it("transient error retries and eventually succeeds", async () => {
    mailer.failWith = new Error("transient");
    mailer.failureBudget = 1;
    mailer.messageId = "ses-retry-ok";
    const { deliveryId, email } = await seedDelivery();

    await queue.add(
      "send",
      {
        deliveryId,
        to: email,
        headers: {},
        subject: "hi",
        html: "<p>hi</p>",
        text: "hi",
      },
      { jobId: deliveryId },
    );

    const row = await waitForStatus(deliveryId, "sent");
    expect(row.providerMessageId).toBe("ses-retry-ok");
    expect(row.attempts).toBeGreaterThanOrEqual(2);
  });

  it("attempts exhausted → 'failed' with error in providerResponse", async () => {
    mailer.failWith = new Error("permanent-ish");
    mailer.failureBudget = 99; // never succeed
    mailer.messageId = null;
    const { deliveryId, email } = await seedDelivery();

    await queue.add(
      "send",
      {
        deliveryId,
        to: email,
        headers: {},
        subject: "hi",
        html: "<p>hi</p>",
        text: "hi",
      },
      { jobId: deliveryId },
    );

    const row = await waitForStatus(deliveryId, "failed");
    expect(row.providerResponse).toMatchObject({ error: "permanent-ish" });
  });

  it("already-terminal 'sent' → job exits without calling mailer (idempotent retry guard)", async () => {
    mailer.failWith = null;
    mailer.failureBudget = 0;
    const sentBefore = mailer.sent.length;

    // Seed a delivery that's already marked 'sent' (simulating a crash
    // after the provider call but before BullMQ ACK on a previous attempt).
    const { deliveryId, email } = await seedDelivery();
    await db
      .update(schema.notificationDeliveries)
      .set({ status: "sent", providerMessageId: "ses-already-sent" })
      .where(eqRow(schema.notificationDeliveries.id, deliveryId));

    await queue.add(
      "send",
      {
        deliveryId,
        to: email,
        headers: {},
        subject: "hi",
        html: "<p>hi</p>",
        text: "hi",
      },
      // Use a unique jobId so BullMQ doesn't dedupe against prior test jobs.
      { jobId: `retry-${deliveryId}` },
    );

    // Give the worker time to process.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(mailer.sent.length).toBe(sentBefore); // no new send
    // Row should still be 'sent' (not regressed to queued or failed).
    const row = await readDelivery(deliveryId);
    expect(row?.status).toBe("sent");
  });

  it("already-terminal 'suppressed' → job exits without calling mailer", async () => {
    mailer.failWith = null;
    mailer.failureBudget = 0;
    const sentBefore = mailer.sent.length;

    const { deliveryId, email } = await seedDelivery();
    await db
      .update(schema.notificationDeliveries)
      .set({ status: "suppressed" })
      .where(eqRow(schema.notificationDeliveries.id, deliveryId));

    await queue.add(
      "send",
      {
        deliveryId,
        to: email,
        headers: {},
        subject: "hi",
        html: "<p>hi</p>",
        text: "hi",
      },
      { jobId: `retry-sup-${deliveryId}` },
    );

    await new Promise((r) => setTimeout(r, 1_500));
    expect(mailer.sent.length).toBe(sentBefore);
    const row = await readDelivery(deliveryId);
    expect(row?.status).toBe("suppressed");
  });
});
