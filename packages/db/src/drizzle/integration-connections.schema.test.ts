import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq, getTableColumns } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { integrationConnections, integrationDeliveries } from "./schema";

describe("integrationConnections table", () => {
  it("has every column from spec §3.1", () => {
    const cols = Object.keys(getTableColumns(integrationConnections));
    expect(cols.sort()).toEqual(
      [
        "id", "projectId", "providerId", "displayName",
        "credentialsCipher", "credentialsHint",
        "enabledEvents", "eventMapping",
        "actionSource", "testEventCode",
        "isEnabled", "lastValidatedAt", "lastError", "lastBackfillAt",
        "createdAt", "updatedAt", "deletedAt",
      ].sort(),
    );
  });

  it("infers expected select / insert types", () => {
    type Row = typeof integrationConnections.$inferSelect;
    const sample: Row = {
      id: "c1", projectId: "p1", providerId: "META_CAPI", displayName: "Test",
      credentialsCipher: "v1:abc", credentialsHint: "Pixel 1234",
      enabledEvents: ["revenue.RENEWAL"], eventMapping: {},
      actionSource: "app", testEventCode: null,
      isEnabled: false, lastValidatedAt: null, lastError: null, lastBackfillAt: null,
      createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
    };
    expect(sample.providerId).toBe("META_CAPI");
  });
});

// ---------------------------------------------------------------------------
// providerId as text (0104) — real Postgres, per-worker DB
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).
// ---------------------------------------------------------------------------

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

describe("providerId as text (0104)", () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzleClient<typeof schema>>;
  let projectId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzleClient(pool, { schema });
    const [project] = await db
      .insert(schema.projects)
      .values({ name: "0104 provider-text test project" })
      .returning();
    if (!project) throw new Error("seed project: no row returned");
    projectId = project.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("accepts arbitrary text providerId on integration_deliveries", async () => {
    const [row] = await db
      .insert(integrationDeliveries)
      .values({
        id: createId(),
        connectionId: createId(),
        projectId,
        providerId: "CUSTOM_WEBHOOK",
        outboxEventId: createId(),
        eventKey: "revenue.RENEWAL",
        status: "pending",
      })
      .returning();
    expect(row?.providerId).toBe("CUSTOM_WEBHOOK");
  });

  it("allows two CUSTOM_WEBHOOK connections for the same project", async () => {
    const [first] = await db
      .insert(integrationConnections)
      .values({
        id: createId(),
        projectId,
        providerId: "CUSTOM_WEBHOOK",
        displayName: "Webhook A",
        credentialsCipher: "v1:a",
        credentialsHint: "hint-a",
        enabledEvents: [],
        eventMapping: {},
        actionSource: "app",
      })
      .returning();
    const [second] = await db
      .insert(integrationConnections)
      .values({
        id: createId(),
        projectId,
        providerId: "CUSTOM_WEBHOOK",
        displayName: "Webhook B",
        credentialsCipher: "v1:b",
        credentialsHint: "hint-b",
        enabledEvents: [],
        eventMapping: {},
        actionSource: "app",
      })
      .returning();
    expect(first?.id).toBeDefined();
    expect(second?.id).toBeDefined();
    expect(first?.id).not.toBe(second?.id);
  });

  it("rejects a second META_CAPI connection for the same project with 23505", async () => {
    await db.insert(integrationConnections).values({
      id: createId(),
      projectId,
      providerId: "META_CAPI",
      displayName: "Meta primary",
      credentialsCipher: "v1:c",
      credentialsHint: "hint-c",
      enabledEvents: [],
      eventMapping: {},
      actionSource: "app",
    });

    // node-postgres errors arrive wrapped in DrizzleQueryError.cause, not as
    // direct properties of the rejected error.
    await expect(
      db.insert(integrationConnections).values({
        id: createId(),
        projectId,
        providerId: "META_CAPI",
        displayName: "Meta duplicate",
        credentialsCipher: "v1:d",
        credentialsHint: "hint-d",
        enabledEvents: [],
        eventMapping: {},
        actionSource: "app",
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("allows re-insert of META_CAPI after the prior row is soft-deleted", async () => {
    const localProjectId = (
      await db
        .insert(schema.projects)
        .values({ name: "0104 soft-delete test project" })
        .returning()
    )[0]?.id;
    if (!localProjectId) throw new Error("seed project: no row returned");

    const [firstRow] = await db
      .insert(integrationConnections)
      .values({
        id: createId(),
        projectId: localProjectId,
        providerId: "META_CAPI",
        displayName: "Meta first",
        credentialsCipher: "v1:e",
        credentialsHint: "hint-e",
        enabledEvents: [],
        eventMapping: {},
        actionSource: "app",
      })
      .returning();
    if (!firstRow) throw new Error("insert: no row returned");

    await db
      .update(integrationConnections)
      .set({ deletedAt: new Date() })
      .where(eq(integrationConnections.id, firstRow.id));

    const [secondRow] = await db
      .insert(integrationConnections)
      .values({
        id: createId(),
        projectId: localProjectId,
        providerId: "META_CAPI",
        displayName: "Meta second",
        credentialsCipher: "v1:f",
        credentialsHint: "hint-f",
        enabledEvents: [],
        eventMapping: {},
        actionSource: "app",
      })
      .returning();
    expect(secondRow?.id).toBeDefined();
  });
});
