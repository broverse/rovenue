// =============================================================
// push-devices repo — integration tests
// =============================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import * as schema from "../schema";
import {
  listActivePushDevicesForUser,
  revokePushDeviceById,
  revokePushDeviceByToken,
  upsertPushDeviceByToken,
} from "./push-devices";

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

describe("push-devices repo", () => {
  it("upsertPushDeviceByToken: conflict on (platform, token) transfers ownership to new userId", async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    const token = `apns-${createId()}`;

    const first = await upsertPushDeviceByToken(db, {
      userId: userA.id,
      platform: "ios",
      token,
      appBundleId: "com.rovenue.app",
      locale: "en-US",
      timezone: "UTC",
    });
    expect(first.userId).toBe(userA.id);

    // Same (platform, token), different userId → ownership transfer.
    const second = await upsertPushDeviceByToken(db, {
      userId: userB.id,
      platform: "ios",
      token,
      appBundleId: "com.rovenue.app",
      locale: "tr",
      timezone: "Europe/Istanbul",
    });
    expect(second.id).toBe(first.id); // same row
    expect(second.userId).toBe(userB.id);
    expect(second.locale).toBe("tr");
    expect(second.timezone).toBe("Europe/Istanbul");
    expect(second.revokedAt).toBeNull();
  });

  it("upsertPushDeviceByToken: clears revokedAt on re-registration", async () => {
    const user = await seedUser();
    const token = `fcm-${createId()}`;

    const inserted = await upsertPushDeviceByToken(db, {
      userId: user.id,
      platform: "android",
      token,
      appBundleId: "com.rovenue.app",
      locale: "en",
      timezone: "UTC",
    });
    await revokePushDeviceById(db, user.id, inserted.id);

    // Confirm revoked.
    const revokedRow = await db
      .select()
      .from(schema.pushDevices)
      .where(eq(schema.pushDevices.id, inserted.id));
    expect(revokedRow[0]!.revokedAt).not.toBeNull();

    // Re-register → revokedAt cleared.
    const reUpserted = await upsertPushDeviceByToken(db, {
      userId: user.id,
      platform: "android",
      token,
      appBundleId: "com.rovenue.app",
      locale: "en",
      timezone: "UTC",
    });
    expect(reUpserted.id).toBe(inserted.id);
    expect(reUpserted.revokedAt).toBeNull();
  });

  it("listActivePushDevicesForUser: excludes revoked rows", async () => {
    const user = await seedUser();
    const active = await upsertPushDeviceByToken(db, {
      userId: user.id,
      platform: "ios",
      token: `t-${createId()}`,
      appBundleId: "com.rovenue.app",
      locale: "en",
      timezone: "UTC",
    });
    const willRevoke = await upsertPushDeviceByToken(db, {
      userId: user.id,
      platform: "android",
      token: `t-${createId()}`,
      appBundleId: "com.rovenue.app",
      locale: "en",
      timezone: "UTC",
    });
    await revokePushDeviceById(db, user.id, willRevoke.id);

    const list = await listActivePushDevicesForUser(db, user.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(active.id);
  });

  it("revokePushDeviceById: scoped to userId — wrong user is a no-op", async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    const device = await upsertPushDeviceByToken(db, {
      userId: userA.id,
      platform: "ios",
      token: `t-${createId()}`,
      appBundleId: "com.rovenue.app",
      locale: "en",
      timezone: "UTC",
    });

    // Wrong owner: silently no-ops.
    await revokePushDeviceById(db, userB.id, device.id);
    const stillActive = await db
      .select()
      .from(schema.pushDevices)
      .where(
        and(
          eq(schema.pushDevices.id, device.id),
          eq(schema.pushDevices.userId, userA.id),
        ),
      );
    expect(stillActive[0]!.revokedAt).toBeNull();
  });

  it("revokePushDeviceByToken: unknown token is a no-op (does not throw)", async () => {
    await expect(
      revokePushDeviceByToken(db, "ios", "definitely-not-a-real-token"),
    ).resolves.toBeUndefined();
  });

  it("revokePushDeviceByToken: revokes the matching row", async () => {
    const user = await seedUser();
    const token = `t-${createId()}`;
    const device = await upsertPushDeviceByToken(db, {
      userId: user.id,
      platform: "ios",
      token,
      appBundleId: "com.rovenue.app",
      locale: "en",
      timezone: "UTC",
    });
    await revokePushDeviceByToken(db, "ios", token);
    const after = await db
      .select()
      .from(schema.pushDevices)
      .where(eq(schema.pushDevices.id, device.id));
    expect(after[0]!.revokedAt).not.toBeNull();
  });
});
