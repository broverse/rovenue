// =============================================================
// claimDeliveryForSend — concurrency integration test
// =============================================================
//
// Verifies the atomic single-flight claim that the send-email /
// send-push workers use to close the concurrent-duplicate TOCTOU
// window. Two sequential claims of the same `queued` row must NOT
// both win: the first flips the row to `sending` and returns true,
// the second sees a non-claimable status and returns false.
//
// Also asserts the existing short-circuit behaviour is preserved:
// a row already `sent`/`suppressed` is never claimable, while a
// genuinely `failed` row remains claimable (retry-after-FAILED).
//
// Infrastructure: runs against dev Postgres (docker-compose host
// port 5433) configured in apps/api/tests/setup.ts. The conditional
// UPDATE + RETURNING semantics need real Postgres, so this can't run
// on the SQLite unit engine.

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { drizzle, getDb } from "@rovenue/db";

const db = getDb();
const schema = drizzle.schema;
const repo = drizzle.notificationDeliveryRepo;

const RUN_ID = Date.now();
const createdUserIds: string[] = [];

async function seedDelivery(
  status:
    | "queued"
    | "sending"
    | "sent"
    | "delivered"
    | "bounced"
    | "failed"
    | "suppressed" = "queued",
): Promise<string> {
  const userId = `u_ndclaim_${RUN_ID}_${createId()}`;
  createdUserIds.push(userId);
  const now = new Date();
  await db.insert(schema.user).values({
    id: userId,
    name: userId,
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
    .values({ notificationId: notif.id, channel: "email", status })
    .returning();
  if (!delivery) throw new Error("seedDelivery: no delivery");
  return delivery.id;
}

async function readStatus(id: string): Promise<string | undefined> {
  const rows = await db
    .select({ status: schema.notificationDeliveries.status })
    .from(schema.notificationDeliveries)
    .where(eq(schema.notificationDeliveries.id, id));
  return rows[0]?.status;
}

afterAll(async () => {
  // FK cascade from user → notifications → notification_deliveries.
  for (const id of createdUserIds) {
    await db.delete(schema.user).where(eq(schema.user.id, id));
  }
});

describe("claimDeliveryForSend (integration)", () => {
  it("two sequential claims of a queued row: only the FIRST wins", async () => {
    const deliveryId = await seedDelivery("queued");

    const first = await repo.claimDeliveryForSend(db, deliveryId);
    const second = await repo.claimDeliveryForSend(db, deliveryId);

    expect(first).toBe(true);
    expect(second).toBe(false);
    // The claim flipped the row to the in-flight `sending` state.
    expect(await readStatus(deliveryId)).toBe("sending");
  });

  it("bumps attempts exactly once per successful claim", async () => {
    const deliveryId = await seedDelivery("queued");
    await repo.claimDeliveryForSend(db, deliveryId); // wins, attempts 0 -> 1
    await repo.claimDeliveryForSend(db, deliveryId); // loses, no bump

    const rows = await db
      .select({ attempts: schema.notificationDeliveries.attempts })
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.id, deliveryId));
    expect(rows[0]?.attempts).toBe(1);
  });

  it("a row already 'sent' is NOT claimable (no resend) and is not regressed", async () => {
    const deliveryId = await seedDelivery("sent");
    const claimed = await repo.claimDeliveryForSend(db, deliveryId);
    expect(claimed).toBe(false);
    expect(await readStatus(deliveryId)).toBe("sent");
  });

  it("a row already 'suppressed' is NOT claimable", async () => {
    const deliveryId = await seedDelivery("suppressed");
    expect(await repo.claimDeliveryForSend(db, deliveryId)).toBe(false);
    expect(await readStatus(deliveryId)).toBe("suppressed");
  });

  it("a genuinely 'failed' row IS still claimable (retry-after-FAILED)", async () => {
    const deliveryId = await seedDelivery("failed");
    const claimed = await repo.claimDeliveryForSend(db, deliveryId);
    expect(claimed).toBe(true);
    expect(await readStatus(deliveryId)).toBe("sending");
  });
});
