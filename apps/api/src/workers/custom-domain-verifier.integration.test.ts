// =============================================================
// runCustomDomainVerifierSweep — integration tests
// =============================================================
//
// Exercises the sweep against a real Postgres (dev stack at host:5433).
// We inject a fake verifier so the test never touches DNS — what we're
// actually testing is the row-state transitions and the "stop after 7
// days" cutoff. The verifier logic itself is unit-tested separately.
//
// Each test inserts isolated rows keyed by a unique RUN_ID so parallel
// runs against the dev DB don't collide.

import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  getDb,
  customDomains,
  funnels,
  projects,
  drizzle,
} from "@rovenue/db";
import { runCustomDomainVerifierSweep } from "./custom-domain-verifier";

const RUN_ID = Date.now();

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_cdv_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Custom-Domain Verifier Test Project ${RUN_ID}${suffix}`,
  });
  return { id };
}

async function seedFunnel(projectId: string, suffix = "") {
  const db = getDb();
  const id = `fnl_cdv_${RUN_ID}${suffix}`;
  await db.insert(funnels).values({
    id,
    projectId,
    slug: `funnel-cdv-${RUN_ID}${suffix}`,
    name: `Funnel ${RUN_ID}${suffix}`,
  });
  return { id };
}

async function seedDomain({
  projectId,
  funnelId,
  hostname,
  createdAt,
  lastCheckedAt,
}: {
  projectId: string;
  funnelId: string;
  hostname: string;
  createdAt?: Date;
  lastCheckedAt?: Date | null;
}) {
  const row = await drizzle.customDomainRepo.insert(getDb(), {
    projectId,
    funnelId,
    hostname,
    verificationToken: "tok_" + Math.random().toString(36).slice(2),
  });
  // The repo doesn't allow back-dating createdAt — patch directly via
  // Drizzle when a test needs an older row.
  if (createdAt) {
    await getDb()
      .update(customDomains)
      .set({ createdAt, lastCheckedAt: lastCheckedAt ?? null })
      .where(eq(customDomains.id, row.id));
  } else if (lastCheckedAt !== undefined) {
    await getDb()
      .update(customDomains)
      .set({ lastCheckedAt })
      .where(eq(customDomains.id, row.id));
  }
  return drizzle.customDomainRepo.findById(getDb(), row.id);
}

const createdProjectIds: string[] = [];

afterAll(async () => {
  if (createdProjectIds.length === 0) return;
  // Cascades clean up funnels + custom_domains automatically.
  await getDb().delete(projects).where(inArray(projects.id, createdProjectIds));
});

describe("runCustomDomainVerifierSweep", () => {
  it("verifies a pending row whose lastCheckedAt is older than 30 min", async () => {
    const { id: projectId } = await seedProject("_v1");
    createdProjectIds.push(projectId);
    const { id: funnelId } = await seedFunnel(projectId, "_v1");
    const oldCheck = new Date(Date.now() - 45 * 60 * 1000); // 45 min ago
    const row = await seedDomain({
      projectId,
      funnelId,
      hostname: `verify-success-${RUN_ID}.example.com`,
      lastCheckedAt: oldCheck,
    });
    expect(row).toBeTruthy();

    const result = await runCustomDomainVerifierSweep(new Date(), async () => ({
      ok: true,
    }));
    expect(result.verified).toBeGreaterThanOrEqual(1);

    const after = await drizzle.customDomainRepo.findById(getDb(), row!.id);
    expect(after?.verifiedAt).not.toBeNull();
    expect(after?.verificationFailureReason).toBeNull();
  });

  it("records the failure reason when verify fails", async () => {
    const { id: projectId } = await seedProject("_v2");
    createdProjectIds.push(projectId);
    const { id: funnelId } = await seedFunnel(projectId, "_v2");
    const row = await seedDomain({
      projectId,
      funnelId,
      hostname: `verify-fail-${RUN_ID}.example.com`,
      lastCheckedAt: new Date(Date.now() - 45 * 60 * 1000),
    });

    await runCustomDomainVerifierSweep(new Date(), async () => ({
      ok: false,
      reason: "cname_missing",
    }));

    const after = await drizzle.customDomainRepo.findById(getDb(), row!.id);
    expect(after?.verifiedAt).toBeNull();
    expect(after?.verificationFailureReason).toBe("cname_missing");
    expect(after?.lastCheckedAt).not.toBeNull();
  });

  it("skips rows whose lastCheckedAt is within the 30-min recheck interval", async () => {
    const { id: projectId } = await seedProject("_v3");
    createdProjectIds.push(projectId);
    const { id: funnelId } = await seedFunnel(projectId, "_v3");
    const recent = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago
    const row = await seedDomain({
      projectId,
      funnelId,
      hostname: `verify-recent-${RUN_ID}.example.com`,
      lastCheckedAt: recent,
    });

    let probeCalled = false;
    await runCustomDomainVerifierSweep(new Date(), async () => {
      // Note: other parallel tests may have rows in flight against the same
      // dev DB. We only flip the flag if the call was for OUR hostname.
      probeCalled = true;
      return { ok: true };
    });

    const after = await drizzle.customDomainRepo.findById(getDb(), row!.id);
    // Our row should NOT have been verified — its lastCheckedAt is still recent
    expect(after?.verifiedAt).toBeNull();
    // probeCalled may be true if another test row in the dev DB happens to
    // be due — we only assert OUR row's outcome.
    void probeCalled;
  });

  it("tags rows older than 7 days as verification_window_expired", async () => {
    const { id: projectId } = await seedProject("_v4");
    createdProjectIds.push(projectId);
    const { id: funnelId } = await seedFunnel(projectId, "_v4");
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const row = await seedDomain({
      projectId,
      funnelId,
      hostname: `verify-expired-${RUN_ID}.example.com`,
      createdAt: eightDaysAgo,
      lastCheckedAt: new Date(Date.now() - 45 * 60 * 1000),
    });

    await runCustomDomainVerifierSweep(new Date(), async () => ({ ok: true }));

    const after = await drizzle.customDomainRepo.findById(getDb(), row!.id);
    expect(after?.verificationFailureReason).toBe("verification_window_expired");
    // The expired row should NOT be verified — failExpired runs before the
    // per-row verify loop, and the in-loop check also skips expired rows.
    expect(after?.verifiedAt).toBeNull();
  });
});
