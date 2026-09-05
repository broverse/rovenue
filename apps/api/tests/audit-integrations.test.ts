// =============================================================
// audit() -> Postgres -> listAuditProofRows -> hashAuditRow round trip
// =============================================================
//
// FIX 1 (final review, ROADMAP §9.3 audit-proof): every hash in this
// feature has so far been produced BY hashAuditRow and checked AGAINST
// hashAuditRow (packages/shared's byte-equality tests), or checked against
// hand-authored HASH0/1/2 literals
// (packages/db/src/drizzle/repositories/audit-logs.proof.integration.test.ts).
// Nothing has ever run the real `audit()` writer, read the row back through
// the real `listAuditProofRows` export path, and confirmed the two
// independently agree on a hash. This closes that loop against real
// Postgres.
//
// The two rows below are deliberately adversarial to the things a
// hand-authored hash cannot exercise:
//  - one has before/after jsonb with keys inserted out of alphabetical
//    order, including a nested object -- a re-hash that relied on
//    JSON.stringify's (unspecified) key order, or that got tripped up by
//    jsonb's own key reordering on write, would disagree here first.
//  - one has userId/ipAddress/userAgent all null -- the webhook-initiated
//    shape AuditEntry documents but that every other test drives through
//    the "system" sentinel instead.

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, projects, drizzle } from "@rovenue/db";
import {
  hashAuditRow,
  type AuditChainPayload,
} from "@rovenue/shared/audit-chain";
import { audit } from "../src/lib/audit";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_auditrt_${RUN_ID}`;

/** Rebuilds exactly the fields `hashAuditRow` covers from a
 *  `listAuditProofRows` row -- the same split the endpoint, its tests, and
 *  the offline verifier all use. */
function payloadOf(row: AuditChainPayload): AuditChainPayload {
  return {
    projectId: row.projectId,
    userId: row.userId,
    action: row.action,
    resource: row.resource,
    resourceId: row.resourceId,
    before: row.before,
    after: row.after,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
    prevHash: row.prevHash,
  };
}

describe("audit() -> listAuditProofRows round trip (real Postgres)", () => {
  afterAll(async () => {
    await drizzle.db
      .delete(drizzle.schema.auditLogs)
      .where(eq(drizzle.schema.auditLogs.projectId, PROJECT_ID));
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("re-hashes a real written row with out-of-order nested jsonb keys", async () => {
    await getDb()
      .insert(projects)
      .values({ id: PROJECT_ID, name: `Audit RT ${RUN_ID}` });

    await audit({
      projectId: PROJECT_ID,
      userId: "user_auditrt",
      action: "product.updated",
      resource: "product",
      resourceId: `prd_auditrt_${RUN_ID}`,
      // Keys deliberately out of alphabetical order, with a nested object
      // whose own keys are also out of order.
      before: { zeta: 1, alpha: { delta: 2, bravo: 3 } },
      after: { omega: { yankee: 1, xray: 2 }, charlie: 4 },
      ipAddress: "198.51.100.7",
      userAgent: "vitest/audit-rt",
    });

    const rows = await drizzle.auditLogRepo.listAuditProofRows(getDb(), {
      projectId: PROJECT_ID,
      limit: 10,
    });
    const row = rows.find((r) => r.action === "product.updated");
    expect(row).toBeDefined();
    expect(row!.rowHash).not.toBeNull();

    expect(hashAuditRow(payloadOf(row!))).toBe(row!.rowHash);
  });

  it("re-hashes a real written row with null userId/ipAddress/userAgent", async () => {
    await audit({
      projectId: PROJECT_ID,
      userId: null,
      action: "stripe.disconnected",
      resource: "project",
      resourceId: PROJECT_ID,
      before: null,
      after: null,
      ipAddress: null,
      userAgent: null,
    });

    const rows = await drizzle.auditLogRepo.listAuditProofRows(getDb(), {
      projectId: PROJECT_ID,
      limit: 10,
    });
    const row = rows.find((r) => r.action === "stripe.disconnected");
    expect(row).toBeDefined();
    expect(row!.userId).toBeNull();
    expect(row!.ipAddress).toBeNull();
    expect(row!.userAgent).toBeNull();
    expect(row!.rowHash).not.toBeNull();

    expect(hashAuditRow(payloadOf(row!))).toBe(row!.rowHash);
  });
});
