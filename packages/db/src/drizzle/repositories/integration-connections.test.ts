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
