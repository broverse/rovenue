// =============================================================
// maybeEmitNewDevice — integration tests
// =============================================================
//
// Exercises the helper end-to-end against the dev Postgres: the
// device upsert + emit happen in real transactions; we assert
// both the user_known_devices row and the outbox row.

import { afterAll, describe, expect, it } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import { drizzle, getDb } from "@rovenue/db";
import {
  fingerprint,
  maybeEmitNewDevice,
} from "./new-device-emit";

const RUN_ID = Date.now();
const db = getDb();
const schema = drizzle.schema;

async function seedUser(suffix: string) {
  const id = `usr_newdev_${RUN_ID}_${suffix}`;
  const now = new Date();
  await db.insert(schema.user).values({
    id,
    name: `nd-${suffix}`,
    email: `${id}@example.test`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

const seededUserIds: string[] = [];
function track(id: string): string {
  seededUserIds.push(id);
  return id;
}

afterAll(async () => {
  for (const id of seededUserIds) {
    await db.delete(schema.user).where(eq(schema.user.id, id));
  }
});

describe.sequential("maybeEmitNewDevice", () => {
  it("first sign-in on a new device → outbox row + isNew=true", async () => {
    const userId = track(await seedUser("first"));

    const result = await maybeEmitNewDevice(db, {
      userId,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      ipAddress: "203.0.113.42",
    });
    expect(result?.isNew).toBe(true);

    const fp = fingerprint(
      "Mozilla/5.0 (X11; Linux x86_64)",
      "203.0.113.42",
    );
    const devices = await db
      .select()
      .from(schema.userKnownDevices)
      .where(eq(schema.userKnownDevices.userId, userId));
    expect(devices).toHaveLength(1);
    expect(devices[0]?.fingerprint).toBe(fp);

    const outbox = await db
      .select()
      .from(schema.outboxEvents)
      .where(
        eq(schema.outboxEvents.eventType, "security.signin.new_device"),
      );
    const match = outbox.find((r) => {
      const p = r.payload as { recipients?: string[] };
      return p.recipients?.includes(userId);
    });
    expect(match).toBeDefined();
    const payload = match!.payload as {
      context: { userAgent: string; ipAddress: string; whenIso: string };
    };
    expect(payload.context.userAgent).toBe("Mozilla/5.0 (X11; Linux x86_64)");
    expect(payload.context.ipAddress).toBe("203.0.113.42");
    expect(payload.context.whenIso).toBeDefined();
  });

  it("returning device → isNew=false + no second outbox row", async () => {
    const userId = track(await seedUser("returning"));

    const ua = "Safari/17";
    const ip = "198.51.100.7";
    const first = await maybeEmitNewDevice(db, {
      userId,
      userAgent: ua,
      ipAddress: ip,
    });
    expect(first?.isNew).toBe(true);

    const second = await maybeEmitNewDevice(db, {
      userId,
      userAgent: ua,
      ipAddress: ip,
    });
    expect(second?.isNew).toBe(false);

    const outbox = await db
      .select()
      .from(schema.outboxEvents)
      .where(
        eq(schema.outboxEvents.eventType, "security.signin.new_device"),
      );
    const matches = outbox.filter((r) => {
      const p = r.payload as { recipients?: string[] };
      return p.recipients?.includes(userId);
    });
    expect(matches).toHaveLength(1);
  });

  it("different IP → new fingerprint → new emit", async () => {
    const userId = track(await seedUser("ipswap"));

    await maybeEmitNewDevice(db, {
      userId,
      userAgent: "iOS/17",
      ipAddress: "10.0.0.1",
    });
    const second = await maybeEmitNewDevice(db, {
      userId,
      userAgent: "iOS/17",
      ipAddress: "10.0.0.2",
    });
    expect(second?.isNew).toBe(true);

    const devices = await db
      .select()
      .from(schema.userKnownDevices)
      .where(eq(schema.userKnownDevices.userId, userId));
    expect(devices).toHaveLength(2);
  });

  it("optional approxLocation propagates into context", async () => {
    const userId = track(await seedUser("loc"));
    await maybeEmitNewDevice(db, {
      userId,
      userAgent: "Chrome/120",
      ipAddress: "192.0.2.1",
      approxLocation: "Istanbul, TR",
    });
    const outbox = await db
      .select()
      .from(schema.outboxEvents)
      .where(
        eq(schema.outboxEvents.eventType, "security.signin.new_device"),
      );
    const match = outbox.find((r) => {
      const p = r.payload as { recipients?: string[] };
      return p.recipients?.includes(userId);
    });
    const payload = match!.payload as {
      context: { approxLocation?: string };
    };
    expect(payload.context.approxLocation).toBe("Istanbul, TR");
  });
});
