// =============================================================
// notification-suppression repo — integration tests
// =============================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import * as schema from "../schema";
import {
  add,
  get,
  isSuppressed,
  remove,
} from "./notification-suppression";

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

function uniqEmail(): string {
  return `${createId()}@example.test`;
}

describe("notificationSuppressionRepo", () => {
  it("round-trips add → isSuppressed", async () => {
    const email = uniqEmail();
    expect(await isSuppressed(db, email)).toBe(false);
    await add(db, { email, reason: "hard_bounce", source: "ses:bounce" });
    expect(await isSuppressed(db, email)).toBe(true);
    const row = await get(db, email);
    expect(row?.reason).toBe("hard_bounce");
    expect(row?.source).toBe("ses:bounce");
  });

  it("normalises case on insert and lookup", async () => {
    const id = createId();
    const upper = `${id}@EXAMPLE.TEST`;
    await add(db, { email: upper, reason: "complaint" });
    expect(await isSuppressed(db, upper)).toBe(true);
    expect(await isSuppressed(db, upper.toLowerCase())).toBe(true);
    const row = await get(db, upper.toUpperCase());
    expect(row?.email).toBe(upper.toLowerCase());
  });

  it("is idempotent on conflict (ON CONFLICT DO NOTHING)", async () => {
    const email = uniqEmail();
    await add(db, { email, reason: "manual", source: "first" });
    await add(db, { email, reason: "complaint", source: "second" });
    const row = await get(db, email);
    // First insert wins — second is a no-op.
    expect(row?.reason).toBe("manual");
    expect(row?.source).toBe("first");
  });

  it("remove deletes the row", async () => {
    const email = uniqEmail();
    await add(db, { email, reason: "manual" });
    expect(await isSuppressed(db, email)).toBe(true);
    await remove(db, email);
    expect(await isSuppressed(db, email)).toBe(false);
    const lingering = await db
      .select()
      .from(schema.notificationSuppressionList)
      .where(eq(schema.notificationSuppressionList.email, email.toLowerCase()));
    expect(lingering).toHaveLength(0);
  });
});
