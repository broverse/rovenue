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
  listDeliveriesForConnection,
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

  it("does NOT dedupe at the database level — idempotency is the provider's job", async () => {
    // This replaces a test that asserted the opposite, and the reason is
    // worth keeping.
    //
    // `integration_deliveries` is PARTITION BY RANGE (created_at), and the
    // old "dedupe" unique index was (connection_id, outbox_event_id,
    // created_at). Because every real insert gets a fresh now(), that
    // index could never enforce two-column dedupe — the conflict never
    // fired in production. The old test only went green because it pinned
    // BOTH inserts to the same hand-written millisecond, manufacturing a
    // collision that production cannot produce. Its own comment said so.
    //
    // The dead `onConflictDoNothing()`-returned-undefined branch was
    // masking a real duplicate-delivery bug: on BullMQ retry-after-success
    // or with concurrent workers, Meta CAPI / TikTok deliver() ran twice
    // and double-sent conversions. Commit 3064f2ce (2026-06-16) dropped
    // the index and moved to provider-native idempotency — both adapters
    // put event_id = outboxEventId in the payload, so the ad platform
    // dedupes server-side.
    //
    // So this asserts the decision, not an accident: a second delivery row
    // for the same (connection, outboxEvent) DOES insert. If someone
    // re-adds a unique index here, this goes red and they have to come
    // read this comment first.
    const projectId = await seedProject();
    const connectionId = await seedConnection(projectId);
    const outboxEventId = createId();
    const sharedCreatedAt = new Date("2025-01-01T00:00:00.000Z");

    const base = {
      connectionId,
      projectId,
      providerId: "META_CAPI" as const,
      outboxEventId,
      eventKey: "revenue.RENEWAL",
      status: "pending" as const,
      attempt: 0,
      createdAt: sharedCreatedAt,
    };

    const first = await insertPendingDelivery(db, { id: createId(), ...base });
    const second = await insertPendingDelivery(db, { id: createId(), ...base });

    // Even with an identical createdAt — the only shape under which the old
    // index could ever have fired — both rows land.
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second!.id).not.toBe(first!.id);
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

// ---------------------------------------------------------------------------
// listDeliveriesForConnection
// ---------------------------------------------------------------------------

describe("listDeliveriesForConnection", () => {
  it("returns rows ordered by createdAt desc with cursor paging", async () => {
    const projectId = await seedProject();
    const connectionId = await seedConnection(projectId);
    for (let i = 0; i < 3; i++) {
      await insertPendingDelivery(db, {
        id: createId(),
        connectionId,
        projectId,
        providerId: "META_CAPI",
        outboxEventId: createId(),
        eventKey: "revenue.RENEWAL",
        status: "pending",
        attempt: 0,
      });
      await new Promise((r) => setTimeout(r, 5));
    }
    const page1 = await listDeliveriesForConnection(db, {
      connectionId,
      limit: 2,
    });
    expect(page1.rows.length).toBe(2);
    expect(page1.nextCursor).toBeDefined();
    const page2 = await listDeliveriesForConnection(db, {
      connectionId,
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.rows.length).toBe(1);
    expect(page2.nextCursor).toBeUndefined();
  });
});
