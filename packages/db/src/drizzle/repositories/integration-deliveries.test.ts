// =============================================================
// integration-deliveries repo — integration tests (real Postgres)
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance.
// Run with:
//   DATABASE_URL='postgresql://rovenue:rovenue@localhost:5433/rovenue' \
//     pnpm --filter @rovenue/db test -- integration-deliveries.test.ts

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import * as schema from "../schema";
import { createConnection } from "./integration-connections";
import {
  insertPendingDelivery,
  updateDeliveryStatus,
} from "./integration-deliveries";

// ---------------------------------------------------------------------------
// Env bootstrap
// ---------------------------------------------------------------------------
process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

// ---------------------------------------------------------------------------
// DB connection owned by this test file
// ---------------------------------------------------------------------------

let pool: Pool;
let db: ReturnType<typeof drizzleClient<typeof schema>>;

beforeAll(() => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  db = drizzleClient(pool, { schema });
});

afterAll(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function seedProject(): Promise<string> {
  const [project] = await db
    .insert(schema.projects)
    .values({ name: `proj-${createId()}` })
    .returning();
  if (!project) throw new Error("seedProject: no row returned");
  return project.id;
}

async function seedConnection(projectId: string): Promise<string> {
  const id = createId();
  await createConnection(db, {
    id,
    projectId,
    providerId: "META_CAPI",
    displayName: "n",
    credentialsCipher: "v1:1",
    credentialsHint: "h",
    enabledEvents: ["revenue.RENEWAL"],
    eventMapping: {},
    actionSource: "app",
  });
  return id;
}

// ---------------------------------------------------------------------------
// insertPendingDelivery
// ---------------------------------------------------------------------------

describe("insertPendingDelivery", () => {
  it("inserts a fresh pending row", async () => {
    const projectId = await seedProject();
    const connectionId = await seedConnection(projectId);
    const outboxEventId = createId();
    const row = await insertPendingDelivery(db, {
      id: createId(),
      connectionId,
      projectId,
      providerId: "META_CAPI",
      outboxEventId,
      eventKey: "revenue.RENEWAL",
      status: "pending",
      attempt: 0,
    });
    expect(row?.status).toBe("pending");
    expect(row?.outboxEventId).toBe(outboxEventId);
  });

  it("returns undefined on dedupe conflict", async () => {
    // The unique index is (connection_id, outbox_event_id, created_at).
    //
    // Strategy: supply an explicit, millisecond-aligned createdAt for BOTH
    // inserts.  Postgres stores timestamps at microsecond precision, so a
    // server-generated NOW() (e.g. .674476) truncated by JS Date to .674 ms
    // and fed back as the second row's createdAt becomes .674000 — a different
    // value, so the constraint is NOT triggered.  By pinning both rows to the
    // same JS Date (zero sub-ms digits), both land as .674000 and the unique
    // index correctly fires on the second insert.
    const projectId = await seedProject();
    const connectionId = await seedConnection(projectId);
    const outboxEventId = createId();
    // Pin to a specific ms-aligned timestamp so both inserts share it exactly.
    const fixedCreatedAt = new Date("2025-01-01T00:00:00.000Z");

    const first = await insertPendingDelivery(db, {
      id: createId(),
      connectionId,
      projectId,
      providerId: "META_CAPI",
      outboxEventId,
      eventKey: "revenue.RENEWAL",
      status: "pending",
      attempt: 0,
      createdAt: fixedCreatedAt,
    });
    if (!first) throw new Error("seed failed: first insert returned undefined");

    // Second insert with the exact same (connectionId, outboxEventId, createdAt)
    // must be silently ignored and return undefined.
    const second = await insertPendingDelivery(db, {
      id: createId(),
      connectionId,
      projectId,
      providerId: "META_CAPI",
      outboxEventId,
      eventKey: "revenue.RENEWAL",
      status: "pending",
      attempt: 0,
      createdAt: fixedCreatedAt,
    });
    expect(second).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// updateDeliveryStatus
// ---------------------------------------------------------------------------

describe("updateDeliveryStatus", () => {
  it("transitions pending → succeeded with httpStatus", async () => {
    const projectId = await seedProject();
    const connectionId = await seedConnection(projectId);
    const id = createId();
    const inserted = await insertPendingDelivery(db, {
      id,
      connectionId,
      projectId,
      providerId: "META_CAPI",
      outboxEventId: createId(),
      eventKey: "revenue.RENEWAL",
      status: "pending",
      attempt: 0,
    });
    if (!inserted) throw new Error("seed failed");
    const updated = await updateDeliveryStatus(db, {
      id: inserted.id,
      createdAt: inserted.createdAt,
      status: "succeeded",
      httpStatus: 200,
      responseBody: '{"events_received":1}',
      attempt: 1,
    });
    expect(updated.status).toBe("succeeded");
    expect(updated.httpStatus).toBe(200);
    expect(updated.attempt).toBe(1);
  });
});
