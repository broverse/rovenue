process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../client";
import { dsarRequests, projects, subscribers } from "../schema";
import {
  claimDsarRequest,
  completeDsarRequest,
  createDsarRequest,
  failDsarRequest,
  findDsarRequestById,
  findOpenDsarRequest,
} from "./dsar-requests";

// Against the ambient Postgres. The partial unique index is the one thing
// worth an integration test here: it cannot be exercised by a mock, and it
// is what stops a concurrent double-submit from starting two exports for
// the same subject.
//
// Every test seeds what it asserts, matching retention-overrides.integration
// .test.ts's precedent — a shared seeded row would make a single `-t` run or
// a shuffled order fail for reasons unrelated to the code under test.

const RUN_ID = Date.now();
const PROJECT_ID = `prj_pro_${RUN_ID}`;
const OTHER_PROJECT_ID = `prj_pro_other_${RUN_ID}`;

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

/**
 * Drizzle rethrows every query failure as a `DrizzleQueryError` with the
 * real `pg` error on `.cause`, so neither `code` nor `constraint` is on the
 * object a caller catches. Walking the chain is the only way to assert on
 * the actual Postgres error — a message substring would match whatever
 * wording the driver happens to use and would keep passing if the
 * constraint were dropped entirely. Copied from
 * retention-overrides.integration.test.ts's `hasPgCode`.
 */
function hasPgCode(err: unknown, code: string): boolean {
  for (let e = err, depth = 0; e != null && depth < 5; depth += 1) {
    const link = e as { code?: unknown; cause?: unknown };
    if (link.code === code) return true;
    e = link.cause;
  }
  return false;
}

async function seedSubscriber(projectId: string, suffix: string): Promise<string> {
  const [row] = await getDb()
    .insert(subscribers)
    .values({
      projectId,
      rovenueId: `rov_${RUN_ID}_${suffix}`,
    })
    .returning();
  if (!row) throw new Error("seedSubscriber: insert returned no row");
  return row.id;
}

async function clearDsarRequests(projectId: string): Promise<void> {
  await getDb().delete(dsarRequests).where(eq(dsarRequests.projectId, projectId));
}

describe("dsar requests", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values([
      { id: PROJECT_ID, name: `PRO ${RUN_ID}` },
      { id: OTHER_PROJECT_ID, name: `PRO other ${RUN_ID}` },
    ]);
  });

  afterAll(async () => {
    const db = getDb();
    // ON DELETE CASCADE from projects covers dsar_requests and
    // subscribers, but delete explicitly first so a failure to cascade
    // shows up as a failing cleanup rather than silent leftovers.
    for (const id of [PROJECT_ID, OTHER_PROJECT_ID]) {
      await clearDsarRequests(id);
      await db.delete(subscribers).where(eq(subscribers.projectId, id));
      await db.delete(projects).where(eq(projects.id, id));
    }
  });

  it("round-trips a request", async () => {
    const subscriberId = await seedSubscriber(PROJECT_ID, "roundtrip");

    const created = await createDsarRequest(getDb(), {
      projectId: PROJECT_ID,
      subscriberId,
      type: "EXPORT",
      requestedBy: "support@customer.example",
    });

    expect(created.status).toBe("PENDING");
    expect(created.subscriberId).toBe(subscriberId);
    expect(created.type).toBe("EXPORT");
    expect(created.requestedBy).toBe("support@customer.example");
    expect(created.artifactKey).toBeNull();
    expect(created.expiresAt).toBeNull();
    expect(created.completedAt).toBeNull();

    const fetched = await findDsarRequestById(getDb(), created.id);
    expect(fetched?.id).toBe(created.id);

    const claimed = await claimDsarRequest(getDb(), created.id);
    expect(claimed?.status).toBe("RUNNING");

    const completed = await completeDsarRequest(getDb(), {
      id: created.id,
      artifactKey: "dsar-exports/some-key.json",
      expiresAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    expect(completed.status).toBe("COMPLETED");
    expect(completed.artifactKey).toBe("dsar-exports/some-key.json");
    expect(completed.expiresAt).toEqual(new Date("2026-10-01T00:00:00.000Z"));
    expect(completed.completedAt).not.toBeNull();
  });

  it("refuses a second OPEN request of the same type for one subject", async () => {
    const subscriberId = await seedSubscriber(PROJECT_ID, "dup");

    await createDsarRequest(getDb(), {
      projectId: PROJECT_ID,
      subscriberId,
      type: "EXPORT",
      requestedBy: "support@customer.example",
    });

    let caught: unknown;
    try {
      await createDsarRequest(getDb(), {
        projectId: PROJECT_ID,
        subscriberId,
        type: "EXPORT",
        requestedBy: "someone-else@customer.example",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(hasPgCode(caught, UNIQUE_VIOLATION)).toBe(true);
  });

  it("allows a new request once the previous one completed", async () => {
    const subscriberId = await seedSubscriber(PROJECT_ID, "retry");

    const first = await createDsarRequest(getDb(), {
      projectId: PROJECT_ID,
      subscriberId,
      type: "EXPORT",
      requestedBy: "support@customer.example",
    });
    await claimDsarRequest(getDb(), first.id);
    await completeDsarRequest(getDb(), {
      id: first.id,
      artifactKey: "dsar-exports/first.json",
      expiresAt: new Date("2026-10-01T00:00:00.000Z"),
    });

    // Otherwise a subject could exercise their rights exactly once, ever.
    const second = await createDsarRequest(getDb(), {
      projectId: PROJECT_ID,
      subscriberId,
      type: "EXPORT",
      requestedBy: "support@customer.example",
    });

    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("PENDING");
  });

  it("allows the same subject an EXPORT and an ERASURE concurrently", async () => {
    const subscriberId = await seedSubscriber(PROJECT_ID, "both-types");

    // They are different rights and must not block each other.
    const exportRequest = await createDsarRequest(getDb(), {
      projectId: PROJECT_ID,
      subscriberId,
      type: "EXPORT",
      requestedBy: "support@customer.example",
    });
    const erasureRequest = await createDsarRequest(getDb(), {
      projectId: PROJECT_ID,
      subscriberId,
      type: "ERASURE",
      requestedBy: "support@customer.example",
    });

    expect(exportRequest.id).not.toBe(erasureRequest.id);
    expect(exportRequest.status).toBe("PENDING");
    expect(erasureRequest.status).toBe("PENDING");
  });

  it("scopes lookups to a project", async () => {
    const subscriberId = await seedSubscriber(PROJECT_ID, "scoped");
    await createDsarRequest(getDb(), {
      projectId: PROJECT_ID,
      subscriberId,
      type: "EXPORT",
      requestedBy: "support@customer.example",
    });

    // A foreign project cannot see the request...
    const fromForeignProject = await findOpenDsarRequest(getDb(), {
      projectId: OTHER_PROJECT_ID,
      subscriberId,
      type: "EXPORT",
    });
    expect(fromForeignProject).toBeNull();

    // ...and the mirror matters as much as the isolation: the owning
    // project can, so this isn't just a repository that refuses everyone.
    const fromOwningProject = await findOpenDsarRequest(getDb(), {
      projectId: PROJECT_ID,
      subscriberId,
      type: "EXPORT",
    });
    expect(fromOwningProject?.subscriberId).toBe(subscriberId);
  });

  it("claim is a no-op race loser when the request is not PENDING", async () => {
    const subscriberId = await seedSubscriber(PROJECT_ID, "claim-race");
    const created = await createDsarRequest(getDb(), {
      projectId: PROJECT_ID,
      subscriberId,
      type: "EXPORT",
      requestedBy: "support@customer.example",
    });

    const winner = await claimDsarRequest(getDb(), created.id);
    expect(winner?.status).toBe("RUNNING");

    // A second claim of the same (now RUNNING) request must not also
    // "win" — that would let two workers run the same export twice.
    const loser = await claimDsarRequest(getDb(), created.id);
    expect(loser).toBeNull();
  });

  it("failDsarRequest records the error and leaves the row terminal", async () => {
    const subscriberId = await seedSubscriber(PROJECT_ID, "fail");
    const created = await createDsarRequest(getDb(), {
      projectId: PROJECT_ID,
      subscriberId,
      type: "EXPORT",
      requestedBy: "support@customer.example",
    });
    await claimDsarRequest(getDb(), created.id);

    const failed = await failDsarRequest(getDb(), created.id, "storage unconfigured");

    expect(failed.status).toBe("FAILED");
    expect(failed.error).toBe("storage unconfigured");

    // A FAILED request is not "open" any more, so the subject can retry.
    const stillOpen = await findOpenDsarRequest(getDb(), {
      projectId: PROJECT_ID,
      subscriberId,
      type: "EXPORT",
    });
    expect(stillOpen).toBeNull();
  });
});
