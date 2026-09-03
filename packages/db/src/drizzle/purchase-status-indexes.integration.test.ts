// =============================================================
// purchases — status partial-index contract
// =============================================================
//
// The two partial indexes on `purchases` encode a status list in their
// WHERE predicate, and that list has to agree with the shared semantics
// table (`sweepable` / `reconcilable`) that the sweep queries derive
// from. Nothing at compile time links the two: schema.ts derives the
// predicate, but the LIVE index is whatever the hand-written migration
// created, and those can silently diverge (0115 recreates both indexes
// by hand because a partial-index predicate embeds Const nodes of the
// enum type it is dropping).
//
// So this reads the predicate back out of pg_indexes rather than
// comparing a hand-built string against itself: the only thing that can
// make it pass is the migration having actually created the index
// Postgres reports.
//
// Requires: DATABASE_URL pointing at a live, migrated Postgres 16
// (the docker-compose dev stack on host port 5433 satisfies this).

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  EXPIRY_SWEEP_STATUSES,
  RECONCILABLE_STATUSES,
  SUBSCRIPTION_STATUSES,
} from "@rovenue/shared/subscription-status";
import { getDb } from "./client";

const EXPIRY_SWEEP_INDEX = "purchases_status_expiresDate_idx";
const RECONCILIATION_INDEX = "purchases_google_reconciliation_idx";

// Postgres does NOT echo back the `IN (...)` the migration was written
// with — pg_get_indexdef normalises it to
//   status = ANY (ARRAY['TRIAL'::"PurchaseStatus", …])
// (and to a bare `status = 'X'::"PurchaseStatus"` for a single value).
// Keying on the cast rather than on the list syntax is what survives
// both renderings, and it also ignores the `'PLAY_STORE'::"Store"`
// literal that shares the reconciliation predicate.
const PURCHASE_STATUS_LITERAL = /'([A-Z_]+)'::"PurchaseStatus"/g;

function statusesInPredicate(indexdef: string): string[] {
  const found = [...indexdef.matchAll(PURCHASE_STATUS_LITERAL)].map(
    (m) => m[1] as string,
  );
  if (found.length === 0) {
    throw new Error(`no PurchaseStatus literals in predicate: ${indexdef}`);
  }
  return found;
}

async function indexDefinition(name: string): Promise<string> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT indexdef FROM pg_indexes
    WHERE tablename = 'purchases'
      AND indexname = ${name}
  `);
  const rows = (result as unknown as { rows: Array<{ indexdef: string }> })
    .rows;
  const def = rows[0]?.indexdef;
  if (!def) throw new Error(`index ${name} does not exist`);
  return def;
}

describe("purchases status partial indexes", () => {
  it("the expiry sweep index lists exactly the sweepable statuses", async () => {
    const def = await indexDefinition(EXPIRY_SWEEP_INDEX);
    expect(statusesInPredicate(def).sort()).toEqual(
      [...EXPIRY_SWEEP_STATUSES].sort(),
    );
  });

  it("the reconciliation index lists exactly the reconcilable statuses", async () => {
    const def = await indexDefinition(RECONCILIATION_INDEX);
    expect(statusesInPredicate(def).sort()).toEqual(
      [...RECONCILABLE_STATUSES].sort(),
    );
  });

  // The whole reason the two lists are separate: an account-hold row's
  // expiresDate is already in the past when the hold appears, so leaving
  // BILLING_ISSUE in the expiry sweep would move it straight to EXPIRED
  // and erase the dunning signal — while the store sweep must keep
  // re-polling it, because a held Play subscription can still recover.
  it("carries BILLING_ISSUE in reconciliation only", async () => {
    expect(
      statusesInPredicate(await indexDefinition(RECONCILIATION_INDEX)),
    ).toContain("BILLING_ISSUE");
    expect(
      statusesInPredicate(await indexDefinition(EXPIRY_SWEEP_INDEX)),
    ).not.toContain("BILLING_ISSUE");
  });

  // The enum swap in 0115 drops and recreates the type. If the label set
  // came back wrong — or "PurchaseStatus_old" survived — every status
  // write would fail at runtime, so pin the live labels too.
  it("the live PurchaseStatus enum matches the shared tuple", async () => {
    const db = getDb();
    const result = await db.execute(sql`
      SELECT e.enumlabel AS label
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'PurchaseStatus'
      ORDER BY e.enumsortorder
    `);
    const labels = (result as unknown as { rows: Array<{ label: string }> })
      .rows.map((r) => r.label);
    expect([...labels].sort()).toEqual([...SUBSCRIPTION_STATUSES].sort());

    const leftovers = await db.execute(sql`
      SELECT typname FROM pg_type WHERE typname = 'PurchaseStatus_old'
    `);
    expect(
      (leftovers as unknown as { rows: unknown[] }).rows,
    ).toHaveLength(0);
  });
});
