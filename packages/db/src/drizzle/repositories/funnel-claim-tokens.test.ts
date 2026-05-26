// =============================================================
// funnel-claim-tokens repo — integration tests (real Postgres)
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).
//
// Covers the atomic single-shot claim semantics of tryClaim: only
// one concurrent caller may win, all others see null.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import * as schema from "../schema";
import {
  funnelClaimTokens,
  funnels,
  funnelSessions,
  funnelVersions,
  projects,
} from "../schema";
import * as repo from "./funnel-claim-tokens";

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

let pool: Pool;
let db: ReturnType<typeof drizzleClient<typeof schema>>;

let funnelId: string;
let versionId: string;
let sessionId: string;
let projectId: string;

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  db = drizzleClient(pool, { schema });

  const [project] = await db
    .insert(projects)
    .values({ name: `Funnel Claim Test ${Date.now()}` })
    .returning();
  projectId = project.id;

  const [f] = await db
    .insert(funnels)
    .values({ projectId, slug: `f-${Date.now()}`, name: "F" })
    .returning();
  funnelId = f.id;

  const [v] = await db
    .insert(funnelVersions)
    .values({
      funnelId,
      versionNo: 1,
      pagesJson: [],
      themeJson: {},
      settingsJson: {},
    })
    .returning();
  versionId = v.id;

  const [s] = await db
    .insert(funnelSessions)
    .values({ funnelId, funnelVersionId: versionId, projectId })
    .returning();
  sessionId = s.id;
});

afterAll(async () => {
  // funnel_claim_tokens references funnel_sessions but has NO FK
  // (session table is partitioned). Clear tokens explicitly before
  // deleting the project. Deleting projects cascades through
  // funnels -> funnel_versions; funnel_sessions cascades on funnels.
  await db.delete(funnelClaimTokens).where(eq(funnelClaimTokens.projectId, projectId));
  await db.delete(projects).where(eq(projects.id, projectId));
  await pool.end();
});

describe("funnel-claim-tokens repo", () => {
  beforeEach(async () => {
    await db.delete(funnelClaimTokens).where(eq(funnelClaimTokens.projectId, projectId));
  });

  it("tryClaim succeeds exactly once under concurrent calls", async () => {
    const [token] = await db
      .insert(funnelClaimTokens)
      .values({
        tokenHash: `h_${Date.now()}_1`,
        sessionId,
        projectId,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();

    const results = await Promise.all([
      repo.tryClaim(db, token.id, "sub_a"),
      repo.tryClaim(db, token.id, "sub_b"),
      repo.tryClaim(db, token.id, "sub_c"),
    ]);
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
  });

  it("tryClaim returns null when already claimed", async () => {
    const [token] = await db
      .insert(funnelClaimTokens)
      .values({
        tokenHash: `h_${Date.now()}_2`,
        sessionId,
        projectId,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    expect(await repo.tryClaim(db, token.id, "sub_a")).not.toBeNull();
    expect(await repo.tryClaim(db, token.id, "sub_b")).toBeNull();
  });
});
