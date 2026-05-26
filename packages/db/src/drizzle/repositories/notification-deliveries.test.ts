// =============================================================
// notification-deliveries repo — integration tests
// =============================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import * as schema from "../schema";
import {
  findDeliveryByProviderMessageId,
  incrementDeliveryAttempts,
  insertNotificationDeliveries,
  markDeliveryStatus,
} from "./notification-deliveries";

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

let pool: Pool;
let db: ReturnType<typeof drizzleClient<typeof schema>>;

beforeAll(() => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  db = drizzleClient(pool, { schema });
});

afterAll(async () => {
  await pool.end();
});

async function seedUser() {
  const id = createId();
  const now = new Date();
  const [row] = await db
    .insert(schema.user)
    .values({
      id,
      name: `user-${id}`,
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error("seedUser: no row returned");
  return row;
}

async function seedNotification(userId: string) {
  const [row] = await db
    .insert(schema.notifications)
    .values({
      userId,
      projectId: null,
      eventKey: "ping",
      eventId: createId(),
      title: "Hi",
      body: "Hello",
    })
    .returning();
  if (!row) throw new Error("seedNotification: no row returned");
  return row;
}

describe("notification-deliveries repo", () => {
  it("insertNotificationDeliveries: preserves input order in RETURNING", async () => {
    const user = await seedUser();
    const note = await seedNotification(user.id);

    const inserted = await insertNotificationDeliveries(db, [
      { notificationId: note.id, channel: "email", status: "queued" },
      { notificationId: note.id, channel: "push", status: "queued" },
      { notificationId: note.id, channel: "inapp", status: "delivered" },
    ]);
    expect(inserted).toHaveLength(3);
    expect(inserted.map((r) => r.channel)).toEqual([
      "email",
      "push",
      "inapp",
    ]);
    expect(inserted.map((r) => r.status)).toEqual([
      "queued",
      "queued",
      "delivered",
    ]);
  });

  it("insertNotificationDeliveries: empty input returns empty array (no DB call)", async () => {
    expect(await insertNotificationDeliveries(db, [])).toEqual([]);
  });

  it("markDeliveryStatus: updates lastAttemptAt + status + provider patch", async () => {
    const user = await seedUser();
    const note = await seedNotification(user.id);
    const [delivery] = await insertNotificationDeliveries(db, [
      { notificationId: note.id, channel: "email", status: "queued" },
    ]);
    expect(delivery!.lastAttemptAt).toBeNull();

    const before = Date.now();
    await markDeliveryStatus(db, delivery!.id, "sent", {
      providerMessageId: "ses-msg-123",
      providerResponse: { ok: true },
    });
    const after = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.id, delivery!.id));
    expect(after[0]!.status).toBe("sent");
    expect(after[0]!.providerMessageId).toBe("ses-msg-123");
    expect(after[0]!.providerResponse).toEqual({ ok: true });
    expect(after[0]!.lastAttemptAt!.getTime()).toBeGreaterThanOrEqual(
      before,
    );
  });

  it("findDeliveryByProviderMessageId: returns null when absent, the row when present", async () => {
    expect(
      await findDeliveryByProviderMessageId(db, "not-a-real-id"),
    ).toBeNull();

    const user = await seedUser();
    const note = await seedNotification(user.id);
    const [delivery] = await insertNotificationDeliveries(db, [
      {
        notificationId: note.id,
        channel: "email",
        status: "sent",
        providerMessageId: "ses-msg-find-me",
      },
    ]);
    const found = await findDeliveryByProviderMessageId(
      db,
      "ses-msg-find-me",
    );
    expect(found).not.toBeNull();
    expect(found!.id).toBe(delivery!.id);
  });

  it("incrementDeliveryAttempts: increments by exactly one per call", async () => {
    const user = await seedUser();
    const note = await seedNotification(user.id);
    const [delivery] = await insertNotificationDeliveries(db, [
      { notificationId: note.id, channel: "email", status: "queued" },
    ]);
    expect(delivery!.attempts).toBe(0);

    await incrementDeliveryAttempts(db, delivery!.id);
    await incrementDeliveryAttempts(db, delivery!.id);
    const after = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.id, delivery!.id));
    expect(after[0]!.attempts).toBe(2);
    expect(after[0]!.lastAttemptAt).not.toBeNull();
  });
});
