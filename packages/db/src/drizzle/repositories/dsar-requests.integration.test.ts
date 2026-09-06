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
  DSAR_CLAIM_STALE_RUNNING_MS,
  failDsarRequest,
  findCompletedExportArtifactsForSubscriber,
  findDsarRequestById,
  findOpenDsarRequest,
  invalidateExportArtifacts,
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
    // Direction 1 of 2 for the stale-RUNNING reclaim guard (see the
    // sibling test below for direction 2): a FRESH RUNNING row — claimed
    // moments ago, well inside DSAR_CLAIM_STALE_RUNNING_MS — must NOT be
    // reclaimable. Catches a reclaim implemented as an unconditional
    // "PENDING OR RUNNING" claim (dropping the staleness check entirely),
    // which would let two workers run the same export/erasure twice.
    const subscriberId = await seedSubscriber(PROJECT_ID, "claim-race");
    const created = await createDsarRequest(getDb(), {
      projectId: PROJECT_ID,
      subscriberId,
      type: "EXPORT",
      requestedBy: "support@customer.example",
    });

    const winner = await claimDsarRequest(getDb(), created.id);
    expect(winner?.status).toBe("RUNNING");

    // A second claim of the same (now RUNNING, still-fresh) request must
    // not also "win".
    const loser = await claimDsarRequest(getDb(), created.id);
    expect(loser).toBeNull();
  });

  it("reclaims a RUNNING row once its lease has gone stale", async () => {
    // Direction 2 of 2: a RUNNING row whose `updatedAt` is OLDER than
    // DSAR_CLAIM_STALE_RUNNING_MS must BE reclaimable — this is the fix
    // for the double-fault bug (work throws, the FAILED-transition
    // transaction itself throws, the row is left RUNNING forever with no
    // reaper). Catches removing the staleness branch entirely (a claim
    // that only ever matches PENDING would leave this permanently wedged,
    // exactly the pre-fix bug) as well as an interval so short/long it
    // stops matching this scenario.
    const subscriberId = await seedSubscriber(PROJECT_ID, "claim-stale-reclaim");
    const created = await createDsarRequest(getDb(), {
      projectId: PROJECT_ID,
      subscriberId,
      type: "EXPORT",
      requestedBy: "support@customer.example",
    });

    const claimedAt = new Date();
    const firstClaim = await claimDsarRequest(getDb(), created.id, claimedAt);
    expect(firstClaim?.status).toBe("RUNNING");

    // Simulates the worker crashing (or the double-fault above) mid-work:
    // the row is left RUNNING with an `updatedAt` from the original claim,
    // now older than the lease.
    const staleNow = new Date(claimedAt.getTime() + DSAR_CLAIM_STALE_RUNNING_MS + 1_000);

    const reclaimed = await claimDsarRequest(getDb(), created.id, staleNow);
    expect(reclaimed?.status).toBe("RUNNING");
    expect(reclaimed?.updatedAt.getTime()).toBe(staleNow.getTime());

    // And it is a genuine re-claim, not a false positive from some other
    // row: the request still resolves to completion afterwards like any
    // other claimed row.
    const completed = await completeDsarRequest(getDb(), {
      id: created.id,
      artifactKey: "dsar-exports/reclaimed.json",
      expiresAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    expect(completed.status).toBe("COMPLETED");
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

  it("finds every COMPLETED export artifact for a subject and invalidates only those", async () => {
    // Finding 1 (roadmap-9a final fix wave): a subject can have MULTIPLE
    // completed exports over their lifetime (dsar.mdx — asking again
    // after a completed export produces a NEW artifact). This pins that
    // `findCompletedExportArtifactsForSubscriber` returns ALL of them,
    // that a row with no artifact (FAILED) or a different type (ERASURE)
    // or a different subscriber is never included, and that
    // `invalidateExportArtifacts` only nulls the ids it's given.
    const subscriberId = await seedSubscriber(PROJECT_ID, "artifacts");
    const otherSubscriberId = await seedSubscriber(PROJECT_ID, "artifacts-other");

    const first = await createDsarRequest(getDb(), {
      projectId: PROJECT_ID,
      subscriberId,
      type: "EXPORT",
      requestedBy: "a@customer.example",
    });
    await claimDsarRequest(getDb(), first.id);
    await completeDsarRequest(getDb(), {
      id: first.id,
      artifactKey: "dsar-exports/first.json",
      expiresAt: new Date("2026-10-01T00:00:00.000Z"),
    });

    const second = await createDsarRequest(getDb(), {
      projectId: PROJECT_ID,
      subscriberId,
      type: "EXPORT",
      requestedBy: "b@customer.example",
    });
    await claimDsarRequest(getDb(), second.id);
    await completeDsarRequest(getDb(), {
      id: second.id,
      artifactKey: "dsar-exports/second.json",
      expiresAt: new Date("2026-10-02T00:00:00.000Z"),
    });

    // Decoys that must NOT be returned: a FAILED export (no live
    // artifact), an ERASURE (never has an artifact), and another
    // subscriber's own completed export.
    const failedExport = await createDsarRequest(getDb(), {
      projectId: PROJECT_ID,
      subscriberId,
      type: "EXPORT",
      requestedBy: "c@customer.example",
    });
    await claimDsarRequest(getDb(), failedExport.id);
    await failDsarRequest(getDb(), failedExport.id, "storage unconfigured");

    const erasure = await createDsarRequest(getDb(), {
      projectId: PROJECT_ID,
      subscriberId,
      type: "ERASURE",
      requestedBy: "d@customer.example",
    });
    await claimDsarRequest(getDb(), erasure.id);
    await completeDsarRequest(getDb(), {
      id: erasure.id,
      artifactKey: null,
      expiresAt: null,
    });

    const otherSubscriberExport = await createDsarRequest(getDb(), {
      projectId: PROJECT_ID,
      subscriberId: otherSubscriberId,
      type: "EXPORT",
      requestedBy: "e@customer.example",
    });
    await claimDsarRequest(getDb(), otherSubscriberExport.id);
    await completeDsarRequest(getDb(), {
      id: otherSubscriberExport.id,
      artifactKey: "dsar-exports/decoy.json",
      expiresAt: new Date("2026-10-03T00:00:00.000Z"),
    });

    const found = await findCompletedExportArtifactsForSubscriber(getDb(), subscriberId);
    expect(found.map((a) => a.id).sort()).toEqual([first.id, second.id].sort());
    expect(found.map((a) => a.artifactKey).sort()).toEqual(
      ["dsar-exports/first.json", "dsar-exports/second.json"].sort(),
    );

    await invalidateExportArtifacts(getDb(), [first.id]);

    const firstAfter = await findDsarRequestById(getDb(), first.id);
    expect(firstAfter?.status).toBe("COMPLETED");
    expect(firstAfter?.artifactKey).toBeNull();
    expect(firstAfter?.expiresAt).toBeNull();

    // The SECOND export (not passed to invalidateExportArtifacts) must be
    // untouched — this is a targeted invalidation, not a subject-wide one.
    const secondAfter = await findDsarRequestById(getDb(), second.id);
    expect(secondAfter?.artifactKey).toBe("dsar-exports/second.json");

    // The decoy from another subscriber is untouched either way.
    const decoyAfter = await findDsarRequestById(getDb(), otherSubscriberExport.id);
    expect(decoyAfter?.artifactKey).toBe("dsar-exports/decoy.json");

    // No longer returned once invalidated.
    const foundAfter = await findCompletedExportArtifactsForSubscriber(getDb(), subscriberId);
    expect(foundAfter.map((a) => a.id)).toEqual([second.id]);
  });

  it("invalidateExportArtifacts is a no-op on an empty list", async () => {
    // Erasure calls this unconditionally after the storage-delete loop,
    // whether or not there was anything to purge — must not throw or
    // touch unrelated rows on an empty id list.
    const subscriberId = await seedSubscriber(PROJECT_ID, "artifacts-noop");
    const created = await createDsarRequest(getDb(), {
      projectId: PROJECT_ID,
      subscriberId,
      type: "EXPORT",
      requestedBy: "support@customer.example",
    });
    await claimDsarRequest(getDb(), created.id);
    await completeDsarRequest(getDb(), {
      id: created.id,
      artifactKey: "dsar-exports/untouched.json",
      expiresAt: new Date("2026-10-01T00:00:00.000Z"),
    });

    await expect(invalidateExportArtifacts(getDb(), [])).resolves.toBeUndefined();

    const after = await findDsarRequestById(getDb(), created.id);
    expect(after?.artifactKey).toBe("dsar-exports/untouched.json");
  });
});
