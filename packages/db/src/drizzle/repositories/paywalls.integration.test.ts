// =============================================================
// paywallRepo — integration tests
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).
// Pattern mirrors the sibling offerings.integration.test.ts suite.
//
// Covers:
//   - create / list / find by id / find by ids / find by identifier
//   - unique (projectId, identifier) violation
//   - update
//   - deletePaywall rejects when referenced by a placement row
//   - deletePaywall rejects when referenced by a PAYWALL experiment variant
//   - deletePaywall succeeds when unreferenced

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../client";
import { audiences, experiments, offerings, paywalls, placements, projects } from "../schema";
import * as paywallRepo from "./paywalls";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_paywalls_${RUN_ID}`;
let offeringId: string;

describe("paywallRepo", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `Paywalls ${RUN_ID}` });
    const [offering] = await db
      .insert(offerings)
      .values({ projectId: PROJECT_ID, identifier: "default", packages: [] })
      .returning();
    offeringId = offering!.id;
  });

  afterAll(async () => {
    const db = getDb();
    await db.delete(placements).where(eq(placements.projectId, PROJECT_ID));
    await db.delete(experiments).where(eq(experiments.projectId, PROJECT_ID));
    await db.delete(paywalls).where(eq(paywalls.projectId, PROJECT_ID));
    await db.delete(audiences).where(eq(audiences.projectId, PROJECT_ID));
    await db.delete(offerings).where(eq(offerings.projectId, PROJECT_ID));
    await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("creates a paywall and lists it", async () => {
    const db = getDb();
    const created = await paywallRepo.createPaywall(db, {
      projectId: PROJECT_ID,
      identifier: "onboarding",
      name: "Onboarding Paywall",
      offeringId,
    });

    expect(created.id).toBeDefined();
    expect(created.identifier).toBe("onboarding");
    expect(created.configFormatVersion).toBe(1);
    expect(created.isActive).toBe(true);

    const list = await paywallRepo.listPaywalls(db, PROJECT_ID);
    expect(list.some((p) => p.id === created.id)).toBe(true);
  });

  it("finds a paywall by id, by ids, and by identifier", async () => {
    const db = getDb();
    const created = await paywallRepo.createPaywall(db, {
      projectId: PROJECT_ID,
      identifier: "find_me",
      name: "Find Me",
      offeringId,
    });

    const byId = await paywallRepo.findPaywallById(db, PROJECT_ID, created.id);
    expect(byId?.id).toBe(created.id);

    const byIds = await paywallRepo.findPaywallsByIds(db, PROJECT_ID, [created.id]);
    expect(byIds.map((p) => p.id)).toContain(created.id);

    const byIdentifier = await paywallRepo.findPaywallByIdentifier(
      db,
      PROJECT_ID,
      "find_me",
    );
    expect(byIdentifier?.id).toBe(created.id);

    const missing = await paywallRepo.findPaywallById(db, PROJECT_ID, "nope");
    expect(missing).toBeNull();
  });

  it("rejects a second paywall with the same (projectId, identifier)", async () => {
    const db = getDb();
    await paywallRepo.createPaywall(db, {
      projectId: PROJECT_ID,
      identifier: "dup_id",
      name: "Dup 1",
      offeringId,
    });

    await expect(
      paywallRepo.createPaywall(db, {
        projectId: PROJECT_ID,
        identifier: "dup_id",
        name: "Dup 2",
        offeringId,
      }),
    ).rejects.toThrow();
  });

  it("updates a paywall", async () => {
    const db = getDb();
    const created = await paywallRepo.createPaywall(db, {
      projectId: PROJECT_ID,
      identifier: "updatable",
      name: "Before",
      offeringId,
    });

    const updated = await paywallRepo.updatePaywall(db, PROJECT_ID, created.id, {
      name: "After",
      isActive: false,
    });

    expect(updated?.name).toBe("After");
    expect(updated?.isActive).toBe(false);
  });

  it("deletePaywall rejects when referenced by a placement row", async () => {
    const db = getDb();
    const paywall = await paywallRepo.createPaywall(db, {
      projectId: PROJECT_ID,
      identifier: "referenced_by_placement",
      name: "Referenced",
      offeringId,
    });

    await db.insert(placements).values({
      projectId: PROJECT_ID,
      identifier: "placement_ref",
      name: "Placement Ref",
      rows: [
        {
          audienceId: null,
          target: { type: "paywall", paywallId: paywall.id },
        },
      ],
    });

    await expect(
      paywallRepo.deletePaywall(db, PROJECT_ID, paywall.id),
    ).rejects.toThrow();

    // Still there afterwards
    const stillThere = await paywallRepo.findPaywallById(db, PROJECT_ID, paywall.id);
    expect(stillThere).not.toBeNull();
  });

  it("deletePaywall rejects when referenced by a PAYWALL experiment variant", async () => {
    const db = getDb();
    const paywall = await paywallRepo.createPaywall(db, {
      projectId: PROJECT_ID,
      identifier: "referenced_by_experiment",
      name: "Referenced by Experiment",
      offeringId,
    });

    const [audience] = await db
      .insert(audiences)
      .values({ projectId: PROJECT_ID, name: `Audience ${RUN_ID}` })
      .returning();

    await db.insert(experiments).values({
      projectId: PROJECT_ID,
      name: "Paywall Experiment",
      type: "PAYWALL",
      key: `exp_${RUN_ID}`,
      audienceId: audience!.id,
      variants: [
        {
          id: "control",
          name: "Control",
          weight: 100,
          value: { paywallId: paywall.id },
        },
      ],
    });

    await expect(
      paywallRepo.deletePaywall(db, PROJECT_ID, paywall.id),
    ).rejects.toThrow();
  });

  it("deletePaywall succeeds when unreferenced", async () => {
    const db = getDb();
    const paywall = await paywallRepo.createPaywall(db, {
      projectId: PROJECT_ID,
      identifier: "unreferenced",
      name: "Unreferenced",
      offeringId,
    });

    const result = await paywallRepo.deletePaywall(db, PROJECT_ID, paywall.id);
    expect(result).toBe(true);

    const gone = await paywallRepo.findPaywallById(db, PROJECT_ID, paywall.id);
    expect(gone).toBeNull();
  });

  it("deletePaywall returns false when the paywall does not exist", async () => {
    const db = getDb();
    const result = await paywallRepo.deletePaywall(db, PROJECT_ID, "does_not_exist");
    expect(result).toBe(false);
  });
});
