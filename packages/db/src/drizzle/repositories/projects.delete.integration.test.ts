// =============================================================
// deleteProject — credit_ledger cascade regression test
// =============================================================
//
// Regression: deleting a project with credit_ledger rows triggered the
// append-only trigger (which rejects uncredentialed DELETE). The fix sets
// SET LOCAL "rovenue.allow_ledger_delete" = 'on' inside deleteProject so
// the cascading DELETE on credit_ledger is permitted.
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../client";
import { creditLedger, projects, subscribers, virtualCurrencies } from "../schema";
import { deleteProject } from "./projects";
import { withLedgerDeleteAuthorized } from "./credit-ledger";

const RUN_ID = Date.now();
const P = `prj_del_${RUN_ID}`;
const S = `sub_del_${RUN_ID}`;
const C = `vc_del_${RUN_ID}`;

// Teardown: if the test failed before the deletion under test, clean up
// using the authorized helper so the afterAll doesn't hit the guard either.
afterAll(async () => {
  const db = getDb();
  const existing = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, P));
  if (existing.length > 0) {
    await withLedgerDeleteAuthorized(db, async (tx) => {
      await tx.delete(projects).where(eq(projects.id, P));
    });
  }
});

describe("deleteProject — credit_ledger cascade", () => {
  it("succeeds when the project has credit_ledger rows (no append-only error)", async () => {
    const db = getDb();

    // Seed: project → subscriber → virtual currency → ledger row
    await db.insert(projects).values({ id: P, name: "del-test-project" });
    await db.insert(subscribers).values({
      id: S,
      projectId: P,
      rovenueId: `rv_del_${RUN_ID}`,
    });
    await db
      .insert(virtualCurrencies)
      .values({ id: C, projectId: P, code: "COIN", name: "Coin" });
    await db.insert(creditLedger).values({
      projectId: P,
      subscriberId: S,
      currencyId: C,
      type: "PURCHASE",
      amount: 100,
      balance: 100,
    });

    // Confirm ledger row exists before deletion
    const before = await db
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.projectId, P));
    expect(before.length).toBe(1);

    // deleteProject must succeed — no append-only trigger error.
    // Wrap in a transaction to mirror the production call site in
    // apps/api/src/routes/dashboard/projects.ts.
    await expect(
      db.transaction(async (tx) => {
        await deleteProject(tx, P);
      }),
    ).resolves.toBeUndefined();

    // Project row must be gone
    const projectRows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, P));
    expect(projectRows.length).toBe(0);

    // Ledger rows must be gone (cascaded)
    const ledgerRows = await db
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.projectId, P));
    expect(ledgerRows.length).toBe(0);
  });

  it("succeeds when called with the pool, not a transaction", async () => {
    const db = getDb();

    // Distinct ids so this case is independent of the one above.
    const P2 = `prj_del_pool_${RUN_ID}`;
    const S2 = `sub_del_pool_${RUN_ID}`;
    const C2 = `vc_del_pool_${RUN_ID}`;

    await db.insert(projects).values({ id: P2, name: "del-pool-project" });
    await db.insert(subscribers).values({
      id: S2,
      projectId: P2,
      rovenueId: `rv_del_pool_${RUN_ID}`,
    });
    await db
      .insert(virtualCurrencies)
      .values({ id: C2, projectId: P2, code: "COIN", name: "Coin" });
    await db.insert(creditLedger).values({
      projectId: P2,
      subscriberId: S2,
      currencyId: C2,
      type: "PURCHASE",
      amount: 100,
      balance: 100,
    });

    // The whole point: no explicit transaction here. `SET LOCAL` inside
    // deleteProject must still take effect, which it only can if the
    // function opens its own transaction.
    await expect(deleteProject(db, P2)).resolves.toBeUndefined();

    const projectRows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, P2));
    expect(projectRows.length).toBe(0);

    const ledgerRows = await db
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.projectId, P2));
    expect(ledgerRows.length).toBe(0);
  });
});
