// =============================================================
// integration-connections repo — integration tests (real Postgres)
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import * as schema from "../schema";
import {
  createConnection,
  getConnection,
  listActiveConnectionsForProject,
  updateConnection,
  softDeleteConnection,
} from "./integration-connections";

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
    .values({ name: "Test Project" })
    .returning();
  if (!project) throw new Error("seedProject: no row returned");
  return project.id;
}

// ---------------------------------------------------------------------------
// createConnection + getConnection
// ---------------------------------------------------------------------------

describe("createConnection", () => {
  let projectId: string;
  beforeEach(async () => {
    projectId = await seedProject();
  });

  it("creates a connection with defaults", async () => {
    const row = await createConnection(db, {
      id: createId(),
      projectId,
      providerId: "META_CAPI",
      displayName: "Meta primary",
      credentialsCipher: "v1:abc",
      credentialsHint: "Pixel 1234…5678",
      enabledEvents: ["revenue.RENEWAL"],
      eventMapping: {},
      actionSource: "app",
    });
    expect(row.isEnabled).toBe(false);
    expect(row.enabledEvents).toEqual(["revenue.RENEWAL"]);
    expect(row.providerId).toBe("META_CAPI");
    const fetched = await getConnection(db, row.id);
    expect(fetched?.id).toBe(row.id);
  });
});

// ---------------------------------------------------------------------------
// listActiveConnectionsForProject
// ---------------------------------------------------------------------------

describe("listActiveConnectionsForProject", () => {
  it("returns only is_enabled=true rows", async () => {
    const projectId = await seedProject();
    const enabledId = createId();
    const disabledId = createId();
    await createConnection(db, {
      id: enabledId,
      projectId,
      providerId: "META_CAPI",
      displayName: "Meta on",
      credentialsCipher: "v1:1",
      credentialsHint: "h",
      enabledEvents: ["revenue.RENEWAL"],
      eventMapping: {},
      actionSource: "app",
      isEnabled: true,
    });
    await createConnection(db, {
      id: disabledId,
      projectId,
      providerId: "TIKTOK_EVENTS",
      displayName: "Tt off",
      credentialsCipher: "v1:2",
      credentialsHint: "h",
      enabledEvents: [],
      eventMapping: {},
      actionSource: "app",
      isEnabled: false,
    });
    const active = await listActiveConnectionsForProject(db, projectId);
    expect(active.map((r) => r.id)).toEqual([enabledId]);
  });
});

// ---------------------------------------------------------------------------
// updateConnection
// ---------------------------------------------------------------------------

describe("updateConnection", () => {
  it("flips is_enabled and sets updatedAt", async () => {
    const projectId = await seedProject();
    const id = createId();
    await createConnection(db, {
      id,
      projectId,
      providerId: "META_CAPI",
      displayName: "n",
      credentialsCipher: "v1:1",
      credentialsHint: "h",
      enabledEvents: [],
      eventMapping: {},
      actionSource: "app",
    });
    const before = await getConnection(db, id);
    await new Promise((r) => setTimeout(r, 10));
    const updated = await updateConnection(db, id, { isEnabled: true });
    expect(updated.isEnabled).toBe(true);
    expect(updated.updatedAt.getTime()).toBeGreaterThan(
      before!.updatedAt.getTime(),
    );
  });
});

// ---------------------------------------------------------------------------
// softDeleteConnection
// ---------------------------------------------------------------------------

describe("softDeleteConnection", () => {
  it("disables and clears credentials", async () => {
    const projectId = await seedProject();
    const id = createId();
    await createConnection(db, {
      id,
      projectId,
      providerId: "META_CAPI",
      displayName: "n",
      credentialsCipher: "v1:secret",
      credentialsHint: "h",
      enabledEvents: ["revenue.RENEWAL"],
      eventMapping: {},
      actionSource: "app",
      isEnabled: true,
    });
    await softDeleteConnection(db, id);
    const row = await getConnection(db, id);
    expect(row?.isEnabled).toBe(false);
    expect(row?.credentialsCipher).toBe("");
  });
});
