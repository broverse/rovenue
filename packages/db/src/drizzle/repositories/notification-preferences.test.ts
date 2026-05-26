// =============================================================
// notification-preferences repo — integration tests
// =============================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import * as schema from "../schema";
import {
  getProjectDefaults,
  getUserChannels,
  getUserProjectOverrides,
  updateUserChannels,
  upsertProjectDefaults,
  upsertUserProjectOverrides,
} from "./notification-preferences";

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

async function seedProject() {
  const [row] = await db
    .insert(schema.projects)
    .values({ name: `proj-${createId()}` })
    .returning();
  if (!row) throw new Error("seedProject: no row returned");
  return row;
}

describe("notification-preferences repo", () => {
  it("getUserChannels: returns null when no preferences row", async () => {
    const user = await seedUser();
    expect(await getUserChannels(db, user.id)).toBeNull();
  });

  it("updateUserChannels: partial patch — push:false leaves email untouched", async () => {
    const user = await seedUser();

    // First call seeds with email=true.
    await updateUserChannels(db, user.id, { email: true, locale: "tr" });
    let channels = await getUserChannels(db, user.id);
    expect(channels).toEqual({
      email: true,
      push: true, // defaults to true when key absent
      locale: "tr",
      timezone: "UTC",
    });

    // Patch only push.
    await updateUserChannels(db, user.id, { push: false });
    channels = await getUserChannels(db, user.id);
    expect(channels).toEqual({
      email: true, // untouched
      push: false,
      locale: "tr", // untouched
      timezone: "UTC",
    });

    // Patch only timezone.
    await updateUserChannels(db, user.id, { timezone: "Europe/Istanbul" });
    channels = await getUserChannels(db, user.id);
    expect(channels!.timezone).toBe("Europe/Istanbul");
    expect(channels!.email).toBe(true);
    expect(channels!.push).toBe(false);
  });

  it("getUserProjectOverrides: returns {} when row absent", async () => {
    const user = await seedUser();
    const project = await seedProject();
    const got = await getUserProjectOverrides(db, user.id, project.id);
    expect(got).toEqual({});
  });

  it("upsertUserProjectOverrides: merges new keys, leaves existing untouched, replaces conflicts", async () => {
    const user = await seedUser();
    const project = await seedProject();

    await upsertUserProjectOverrides(db, user.id, project.id, {
      "subscriber.churned": true,
      "experiment.completed": false,
    });

    await upsertUserProjectOverrides(db, user.id, project.id, {
      "feature_flag.changed": true, // new key
      "experiment.completed": true, // overwrite
    });

    const got = await getUserProjectOverrides(db, user.id, project.id);
    expect(got).toEqual({
      "subscriber.churned": true, // untouched
      "experiment.completed": true, // overwritten
      "feature_flag.changed": true, // new
    });

    // Confirm there's only one row (UNIQUE on userId+projectId).
    const rows = await db
      .select()
      .from(schema.userProjectNotificationPrefs)
      .where(eq(schema.userProjectNotificationPrefs.userId, user.id));
    expect(rows).toHaveLength(1);
  });

  it("upsertProjectDefaults: merges defaults, returns {} when absent", async () => {
    const project = await seedProject();
    expect(await getProjectDefaults(db, project.id)).toEqual({});

    await upsertProjectDefaults(db, project.id, {
      "subscriber.churned": true,
    });
    await upsertProjectDefaults(db, project.id, {
      "subscriber.churned": false, // overwrite
      "team.invited": true, // new
    });

    expect(await getProjectDefaults(db, project.id)).toEqual({
      "subscriber.churned": false,
      "team.invited": true,
    });
  });
});
