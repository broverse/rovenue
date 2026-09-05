// =============================================================
// Migration 0123 — widen enabled_events for connections that already
// receive purchases
//
// `integration_connections.enabled_events` is a stored text[] written
// from whatever the dashboard submitted at connection-creation time —
// there is no defaulting to the catalog. A connection created before
// this release CANNOT hold `revenue.NON_RENEWING_PURCHASE`, a key that
// did not exist then. Splitting revenue.INITIAL into
// revenue.CREDIT_PURCHASE / revenue.NON_RENEWING_PURCHASE (Task 6/7)
// would otherwise silently stop delivering purchase events to every
// pre-existing connection.
//
// The worker database this file runs against (tests/setup.ts) is
// cloned from a template built by `runFreshInstall`, which already
// walks the full migration journal — so migration 0123 has already run
// once, against an empty table, before any test here executes. To
// verify its effect we re-apply its exact SQL (read straight off disk,
// the same file the real migration runner ships) against connection
// rows seeded here to look like pre-release data. The migration's own
// idempotence (asserted below) is what makes that valid: applying it
// twice is defined to behave exactly like applying it once.
// =============================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle, getDb, getPool, projects } from "@rovenue/db";

// `integrationConnections` is not in the curated top-level barrel
// (packages/db/src/index.ts re-exports only a fixed table list), but the
// `drizzle` namespace re-export always carries the full schema — see
// `drizzle.schema.integrationConnections` there.
const { integrationConnections } = drizzle;

const RUN_ID = Date.now();
const PROJECT_ID = `prj_intconn_purchase_keys_${RUN_ID}`;

const MIGRATION_SQL = readFileSync(
  join(
    __dirname,
    "../../../packages/db/drizzle/migrations/0123_integration_connections_purchase_keys.sql",
  ),
  "utf-8",
);

async function applyMigration(): Promise<void> {
  await getPool().query(MIGRATION_SQL);
}

async function seedConnection(
  id: string,
  enabledEvents: string[],
): Promise<void> {
  await getDb()
    .insert(integrationConnections)
    .values({
      id,
      projectId: PROJECT_ID,
      // Distinct per connection: (project_id, provider_id) is partial-
      // unique-indexed, and this suite seeds several connections under
      // one project.
      providerId: `META_CAPI_${id}`,
      displayName: `Test connection ${id}`,
      credentialsCipher: "cipher",
      credentialsHint: "hint",
      enabledEvents,
    });
}

async function readEnabledEvents(id: string): Promise<string[]> {
  const [row] = await getDb()
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, id));
  if (!row) throw new Error(`connection ${id} not found`);
  return row.enabledEvents;
}

describe("migration 0123 — integration_connections purchase keys", () => {
  beforeAll(async () => {
    await getDb()
      .insert(projects)
      .values({ id: PROJECT_ID, name: `Purchase keys ${RUN_ID}` });
  });

  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("widens a connection that already receives purchase events", async () => {
    const id = `intconn_widen_${RUN_ID}`;
    await seedConnection(id, ["revenue.INITIAL", "revenue.RENEWAL"]);

    await applyMigration();

    const enabledEvents = await readEnabledEvents(id);
    expect(enabledEvents).toEqual(
      expect.arrayContaining([
        "revenue.INITIAL",
        "revenue.RENEWAL",
        "revenue.CREDIT_PURCHASE",
        "revenue.NON_RENEWING_PURCHASE",
      ]),
    );
    expect(enabledEvents).toHaveLength(4);
  });

  it("leaves a connection that opted out of purchase events byte-identical", async () => {
    const id = `intconn_optout_${RUN_ID}`;
    await seedConnection(id, ["subscription.expired"]);

    await applyMigration();

    const enabledEvents = await readEnabledEvents(id);
    expect(enabledEvents).toEqual(["subscription.expired"]);
  });

  it("does not enable revenue.REACTIVATION for anyone", async () => {
    const id = `intconn_no_reactivation_${RUN_ID}`;
    await seedConnection(id, ["revenue.INITIAL"]);

    await applyMigration();

    const enabledEvents = await readEnabledEvents(id);
    expect(enabledEvents).not.toContain("revenue.REACTIVATION");
  });

  it("does not duplicate a key a connection already has enabled", async () => {
    const id = `intconn_no_dup_${RUN_ID}`;
    await seedConnection(id, ["revenue.INITIAL", "revenue.CREDIT_PURCHASE"]);

    await applyMigration();
    await applyMigration(); // re-running must be a no-op

    const enabledEvents = await readEnabledEvents(id);
    expect(
      enabledEvents.filter((e) => e === "revenue.CREDIT_PURCHASE"),
    ).toHaveLength(1);
    expect(enabledEvents).toEqual(
      expect.arrayContaining([
        "revenue.INITIAL",
        "revenue.CREDIT_PURCHASE",
        "revenue.NON_RENEWING_PURCHASE",
      ]),
    );
    expect(enabledEvents).toHaveLength(3);
  });
});
