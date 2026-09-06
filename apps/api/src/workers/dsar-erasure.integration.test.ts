// =============================================================
// dsar-erasure worker — real-infra integration tests (ROADMAP §9.1, Task 5)
// =============================================================
//
// Real Postgres for everything DB-shaped (`claimDsarRequest`,
// `completeDsarRequest`, `failDsarRequest`, `audit()`, `anonymizeSubscriber`)
// via the ambient docker-compose Postgres, and — the point of this file —
// REAL ClickHouse (ambient, localhost:8124) for the purge. Mocked
// ClickHouse would prove nothing here: this repo has shipped a query
// against non-existent columns that was green in CI precisely because the
// client was mocked (see clickhouse-revenue-type-contract.integration.test.ts
// for the fix). Every test below either runs the real
// `purgeSubscriberFromClickHouseTables` against the real ambient
// ClickHouse, or (the timeout case) calls that SAME real function with an
// unrealistically small bound — never a fake ClickHouse client.
//
// Table list under test: DSAR_ERASURE_CLICKHOUSE_TABLES (see
// dsar-erasure.ts's module doc for the full inclusion/exclusion audit
// against every migration in packages/db/clickhouse/migrations). The task
// spec named only raw_revenue_events / raw_credit_ledger; this suite seeds
// and asserts against all FIVE tables that actually carry a plain
// subscriberId column at rest, to prove that list — not the spec's
// incomplete one — is what the worker purges.
//
// "leaves the subject erased after a later attribute write" is Task 1's
// guarantee (a dead-ended subscriber's attribute write must not resurrect
// the row) verified end-to-end through the REAL erasure worker, not a
// hand-crafted soft delete — modeled directly on
// routes/v1/me-dead-ended.integration.test.ts, which proves the same
// contract against a bare `anonymizeSubscriber` call.

import { afterAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createId } from "@paralleldrive/cuid2";
import { drizzle, getDb } from "@rovenue/db";
import {
  runDsarErasure,
  purgeSubscriberFromClickHouseTables,
  DSAR_ERASURE_CLICKHOUSE_TABLES,
  DSAR_ERASURE_CLICKHOUSE_DATABASE,
  type DsarErasureDeps,
} from "./dsar-erasure";
import { getClickHouseClient, isClickHouseConfigured } from "../lib/clickhouse";
import { anonymizeSubscriber } from "../services/gdpr/anonymize-subscriber";
import { audit } from "../lib/audit";
import { apiKeyAuth } from "../middleware/api-key-auth";
import { errorHandler } from "../middleware/error";
import { meRoute } from "../routes/v1/me";

const schema = drizzle.schema;

const RUN_ID = Date.now();
let seq = 0;
function nextSuffix(): string {
  seq += 1;
  return `${RUN_ID}_${seq}`;
}

// A generous row count for the "waits for the mutation to finish" test:
// large enough that ClickHouse's asynchronous mutation executor cannot
// possibly finish the DELETE before this process can query
// system.mutations again in the same tick — which is exactly the gap a
// worker that marks COMPLETED on mutation SUBMISSION (rather than
// completion) would paper over.
const MUTATION_WAIT_TEST_ROW_COUNT = 500;

// A short-but-realistic bound for the deliberately-stuck-mutation test
// below. Its determinism comes from SYSTEM STOP MERGES (real ClickHouse
// genuinely never finishes the mutation while merges are stopped), not
// from the bound being unrealistically tiny — a row-count-driven "make it
// slow enough" approach was tried first and measured non-deterministic
// (a 200k-row DELETE on this local ClickHouse still finished in ~75-100ms,
// racing a 1ms bound unpredictably depending on submission overhead).
const STUCK_MUTATION_TIMEOUT_MS = 300;
const STUCK_MUTATION_POLL_INTERVAL_MS = 50;

let seededProjectIds: string[] = [];

async function seedProject(): Promise<string> {
  const id = `prj_dsar_erasure_${nextSuffix()}`;
  await getDb().insert(schema.projects).values({ id, name: `dsar-erasure-${id}` });
  seededProjectIds.push(id);
  return id;
}

async function seedSubscriber(projectId: string, rovenueId?: string): Promise<string> {
  const [row] = await getDb()
    .insert(schema.subscribers)
    .values({ projectId, rovenueId: rovenueId ?? `rov_${nextSuffix()}` })
    .returning();
  if (!row) throw new Error("seed: subscriber insert returned no row");
  return row.id;
}

async function seedPendingErasureRequest(
  projectId: string,
  subscriberId: string,
): Promise<string> {
  const row = await drizzle.dsarRequestRepo.createDsarRequest(getDb(), {
    projectId,
    subscriberId,
    type: "ERASURE",
    requestedBy: "support@customer.example",
  });
  return row.id;
}

async function fetchRequest(id: string) {
  const row = await drizzle.dsarRequestRepo.findDsarRequestById(getDb(), id);
  if (!row) throw new Error(`request ${id} vanished`);
  return row;
}

async function fetchSubscriber(id: string) {
  const [row] = await getDb()
    .select()
    .from(schema.subscribers)
    .where(eq(schema.subscribers.id, id));
  if (!row) throw new Error(`subscriber ${id} vanished`);
  return row;
}

/**
 * Builds a DsarErasureDeps where the DB-shaped operations (claim,
 * complete, fail, audit, transaction, anonymizeSubscriber) and the
 * ClickHouse configured-check/purge are the REAL implementations against
 * ambient Postgres + ClickHouse. Nothing here is mocked to always succeed;
 * overrides are passed per test only where a specific test needs to
 * observe a different (still real) code path.
 */
function realDeps(overrides: Partial<DsarErasureDeps> = {}): DsarErasureDeps {
  return {
    claimDsarRequest: vi.fn(drizzle.dsarRequestRepo.claimDsarRequest),
    completeDsarRequest: vi.fn(drizzle.dsarRequestRepo.completeDsarRequest),
    failDsarRequest: vi.fn(drizzle.dsarRequestRepo.failDsarRequest),
    anonymizeSubscriber: vi.fn(anonymizeSubscriber),
    isClickHouseConfigured: vi.fn(isClickHouseConfigured),
    purgeSubscriberFromClickHouse: vi.fn((subscriberId: string) =>
      purgeSubscriberFromClickHouseTables(subscriberId),
    ),
    audit: vi.fn(audit),
    transaction: (fn) => getDb().transaction((tx) => fn(tx as never)),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ClickHouse seed / read helpers — one per table in
// DSAR_ERASURE_CLICKHOUSE_TABLES, so the seeded row shape always matches the
// table actually being asserted against.
// ---------------------------------------------------------------------------

function chDateTime(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

async function seedRawExposures(
  projectId: string,
  subscriberId: string,
  count = 1,
): Promise<void> {
  const ch = getClickHouseClient();
  const rows = Array.from({ length: count }, (_, i) => ({
    eventId: `exp_${subscriberId}_${i}`,
    experimentId: `experiment_${nextSuffix()}`,
    variantId: "control",
    projectId,
    subscriberId,
    platform: "ios",
    country: "US",
    exposedAt: chDateTime(new Date()),
  }));
  await ch.insert({ table: "raw_exposures", values: rows, format: "JSONEachRow" });
}

async function seedRawRevenueEvents(
  projectId: string,
  subscriberId: string,
  count = 1,
): Promise<void> {
  const ch = getClickHouseClient();
  const rows = Array.from({ length: count }, (_, i) => {
    const id = `rev_${subscriberId}_${i}`;
    return {
      eventId: id,
      revenueEventId: id,
      projectId,
      subscriberId,
      purchaseId: `pur_${subscriberId}`,
      productId: "prod_dsar_erasure",
      type: "INITIAL",
      store: "APP_STORE",
      amount: "9.9900",
      amountUsd: "9.9900",
      currency: "USD",
      eventDate: chDateTime(new Date()),
      ingestedAt: chDateTime(new Date()),
      _version: Date.now() + i,
    };
  });
  await ch.insert({ table: "raw_revenue_events", values: rows, format: "JSONEachRow" });
}

async function seedRawCreditLedger(
  projectId: string,
  subscriberId: string,
  count = 1,
): Promise<void> {
  const ch = getClickHouseClient();
  const rows = Array.from({ length: count }, (_, i) => ({
    eventId: `cred_${subscriberId}_${i}`,
    creditLedgerId: `ledger_${subscriberId}_${i}`,
    projectId,
    subscriberId,
    currencyId: "cur_default",
    type: "GRANT",
    amount: 10,
    balance: 10,
    referenceType: null,
    referenceId: null,
    createdAt: chDateTime(new Date()),
    ingestedAt: chDateTime(new Date()),
    _version: Date.now() + i,
  }));
  await ch.insert({ table: "raw_credit_ledger", values: rows, format: "JSONEachRow" });
}

async function seedRawSdkSessionEvents(
  projectId: string,
  subscriberId: string,
  count = 1,
): Promise<void> {
  const ch = getClickHouseClient();
  const rows = Array.from({ length: count }, (_, i) => ({
    eventId: `sess_${subscriberId}_${i}`,
    projectId,
    subscriberId,
    eventType: "close",
    occurredAt: chDateTime(new Date()),
    durationMs: 30_000,
    appVersion: "1.0.0",
    sdkVersion: "1.0.0",
    ingestedAt: chDateTime(new Date()),
    _version: Date.now() + i,
  }));
  await ch.insert({ table: "raw_sdk_session_events", values: rows, format: "JSONEachRow" });
}

async function seedRawPaywallEvents(
  projectId: string,
  subscriberId: string,
  count = 1,
): Promise<void> {
  const ch = getClickHouseClient();
  const rows = Array.from({ length: count }, (_, i) => ({
    eventId: `pwe_${subscriberId}_${i}`,
    projectId,
    subscriberId,
    paywallId: `paywall_${nextSuffix()}`,
    placementId: `placement_${nextSuffix()}`,
    placementRevision: 1,
    variantId: null,
    experimentKey: null,
    occurredAt: chDateTime(new Date()),
    kind: "view",
  }));
  await ch.insert({ table: "raw_paywall_events", values: rows, format: "JSONEachRow" });
}

/** Seeds exactly one row for `subscriberId` into every table under test. */
async function seedAllClickHouseTables(
  projectId: string,
  subscriberId: string,
): Promise<void> {
  await Promise.all([
    seedRawExposures(projectId, subscriberId),
    seedRawRevenueEvents(projectId, subscriberId),
    seedRawCreditLedger(projectId, subscriberId),
    seedRawSdkSessionEvents(projectId, subscriberId),
    seedRawPaywallEvents(projectId, subscriberId),
  ]);
}

async function countRowsFor(table: string, subscriberId: string): Promise<number> {
  const ch = getClickHouseClient();
  const res = await ch.query({
    query: `SELECT count() AS c FROM ${DSAR_ERASURE_CLICKHOUSE_DATABASE}.${table} WHERE subscriberId = {subscriberId:String}`,
    query_params: { subscriberId },
    format: "JSONEachRow",
  });
  const rows = (await res.json()) as Array<{ c: string | number }>;
  return Number(rows[0]?.c ?? 0);
}

async function countAllTablesFor(subscriberId: string): Promise<Record<string, number>> {
  const entries = await Promise.all(
    DSAR_ERASURE_CLICKHOUSE_TABLES.map(async (table) => [
      table,
      await countRowsFor(table, subscriberId),
    ] as const),
  );
  return Object.fromEntries(entries);
}

/** Latest mutation row for `table`/`subscriberId`, read directly from
 * system.mutations — independent of anything the worker itself reports,
 * so this is a check ON the worker, not an echo of it. */
async function latestMutationFor(
  table: string,
  subscriberId: string,
): Promise<{ is_done: number; latest_fail_reason: string } | undefined> {
  const ch = getClickHouseClient();
  const res = await ch.query({
    query: `
      SELECT is_done, latest_fail_reason
      FROM system.mutations
      WHERE database = {database:String}
        AND table = {table:String}
        AND command LIKE {pattern:String}
      ORDER BY create_time DESC
      LIMIT 1
    `,
    query_params: {
      database: DSAR_ERASURE_CLICKHOUSE_DATABASE,
      table,
      pattern: `%${subscriberId}%`,
    },
    format: "JSONEachRow",
  });
  const rows = (await res.json()) as Array<{
    is_done: number | string;
    latest_fail_reason: string;
  }>;
  const row = rows[0];
  return row ? { is_done: Number(row.is_done), latest_fail_reason: row.latest_fail_reason } : undefined;
}

/**
 * ClickHouse executes `ALTER TABLE ... DELETE` through its background
 * merge mechanism, so `SYSTEM STOP MERGES` on a table genuinely, verifiably
 * prevents any mutation against it from ever reaching `is_done = 1` until
 * merges are restarted — confirmed against this exact ClickHouse image
 * (24.3) during development: `SYSTEM STOP MUTATIONS` is NOT valid syntax on
 * this version ("Expected one of: ... MERGES ..."), but `SYSTEM STOP
 * MERGES` is, and a mutation submitted while merges are stopped stays
 * `is_done = 0` indefinitely. This is what makes the "does not finish in
 * time" test below deterministic against REAL ClickHouse: not a mocked
 * client, and not a row-count guess about how long a real DELETE happens
 * to take (measured non-deterministic in isolation — a 200k-row DELETE
 * finished in ~75-100ms, which does not reliably lose a race against any
 * particular timeout bound).
 */
async function stopMerges(table: string): Promise<void> {
  await getClickHouseClient().command({
    query: `SYSTEM STOP MERGES ${DSAR_ERASURE_CLICKHOUSE_DATABASE}.${table}`,
  });
}

async function startMerges(table: string): Promise<void> {
  await getClickHouseClient().command({
    query: `SYSTEM START MERGES ${DSAR_ERASURE_CLICKHOUSE_DATABASE}.${table}`,
  });
}

afterAll(async () => {
  const db = getDb();
  for (const id of seededProjectIds) {
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.projectId, id));
    await db.delete(schema.dsarRequests).where(eq(schema.dsarRequests.projectId, id));
    await db.delete(schema.subscribers).where(eq(schema.subscribers.projectId, id));
    await db.delete(schema.projects).where(eq(schema.projects.id, id));
  }
});

describe("runDsarErasure", () => {
  it("anonymizes in Postgres and purges ClickHouse", async () => {
    // Catches: a worker that anonymizes Postgres but never touches
    // ClickHouse at all (Ruling C's whole point — analytics rows keyed to
    // a stable pseudonym are not erasure).
    const projectId = await seedProject();
    const subscriberId = await seedSubscriber(projectId);
    const decoySubscriberId = await seedSubscriber(projectId);
    const dsarRequestId = await seedPendingErasureRequest(projectId, subscriberId);

    await seedAllClickHouseTables(projectId, subscriberId);
    await seedAllClickHouseTables(projectId, decoySubscriberId);

    const outcome = await runDsarErasure(
      { dsarRequestId, projectId, subscriberId, type: "ERASURE" },
      realDeps(),
    );
    expect(outcome).toEqual({ outcome: "completed" });

    // Postgres half.
    const subscriberRow = await fetchSubscriber(subscriberId);
    expect(subscriberRow.appUserId).toMatch(/^anon_/);
    expect(subscriberRow.deletedAt).not.toBeNull();
    expect(subscriberRow.attributes).toEqual({});

    const finalRequest = await fetchRequest(dsarRequestId);
    expect(finalRequest.status).toBe("COMPLETED");
    expect(finalRequest.artifactKey).toBeNull();

    // ClickHouse half: every table this worker claims to purge is
    // actually empty for the erased subject...
    const counts = await countAllTablesFor(subscriberId);
    for (const table of DSAR_ERASURE_CLICKHOUSE_TABLES) {
      expect(counts[table], `${table} still has rows for the erased subject`).toBe(0);
    }
    // ...and the decoy subject (a different subscriber, never erased) is
    // untouched — this is a real per-subject DELETE, not a table truncate.
    const decoyCounts = await countAllTablesFor(decoySubscriberId);
    for (const table of DSAR_ERASURE_CLICKHOUSE_TABLES) {
      expect(decoyCounts[table], `${table} lost the decoy subject's row`).toBe(1);
    }
  }, 60_000);

  it("waits for the mutation to finish before marking COMPLETED", async () => {
    // Catches: a worker that marks COMPLETED right after SUBMITTING the
    // ALTER ... DELETE, before ClickHouse has actually finished it.
    // Verified by a RED CHECK during development (see task-5-report.md):
    // moving the COMPLETED write to before the mutation-wait loop made
    // this exact assertion fail.
    const projectId = await seedProject();
    const subscriberId = await seedSubscriber(projectId);
    const dsarRequestId = await seedPendingErasureRequest(projectId, subscriberId);

    // A large-enough row count that the DELETE mutation cannot possibly
    // be picked up and finished by ClickHouse's background executor
    // before this process can issue its own independent
    // system.mutations query in the same tick.
    await seedRawRevenueEvents(projectId, subscriberId, MUTATION_WAIT_TEST_ROW_COUNT);

    const outcome = await runDsarErasure(
      { dsarRequestId, projectId, subscriberId, type: "ERASURE" },
      realDeps(),
    );
    expect(outcome).toEqual({ outcome: "completed" });

    // Independent check: query system.mutations directly (NOT via
    // anything the worker itself reported) for every table under test.
    // Every one must show is_done = 1 by the time runDsarErasure has
    // already returned.
    for (const table of DSAR_ERASURE_CLICKHOUSE_TABLES) {
      const mutation = await latestMutationFor(table, subscriberId);
      expect(mutation, `no mutation recorded for ${table}`).toBeDefined();
      expect(mutation!.is_done, `${table}'s mutation was not done when the worker returned`).toBe(1);
    }

    const counts = await countAllTablesFor(subscriberId);
    for (const table of DSAR_ERASURE_CLICKHOUSE_TABLES) {
      expect(counts[table]).toBe(0);
    }
  }, 60_000);

  it("marks FAILED if the mutation does not finish in time", async () => {
    // Catches: a worker with no bounded wait at all (would hang forever
    // on a stuck mutation) or one that swallows a timeout as success.
    // Forces a genuinely stuck mutation with SYSTEM STOP MERGES (see
    // stopMerges' doc comment) — real ClickHouse, real DELETE submitted,
    // real polling of system.mutations, deliberately prevented from ever
    // completing during the assertion window, not a mocked client.
    const projectId = await seedProject();
    const subscriberId = await seedSubscriber(projectId);
    const dsarRequestId = await seedPendingErasureRequest(projectId, subscriberId);
    await seedRawExposures(projectId, subscriberId);

    await stopMerges("raw_exposures");
    try {
      const deps = realDeps({
        purgeSubscriberFromClickHouse: (id: string) =>
          purgeSubscriberFromClickHouseTables(id, {
            timeoutMs: STUCK_MUTATION_TIMEOUT_MS,
            pollIntervalMs: STUCK_MUTATION_POLL_INTERVAL_MS,
          }),
      });

      const outcome = await runDsarErasure(
        { dsarRequestId, projectId, subscriberId, type: "ERASURE" },
        deps,
      );
      expect(outcome.outcome).toBe("failed");
      if (outcome.outcome === "failed") {
        expect(outcome.error).toMatch(/did not finish within/i);
      }

      const finalRequest = await fetchRequest(dsarRequestId);
      expect(finalRequest.status).toBe("FAILED");
      expect(finalRequest.error).toMatch(/did not finish within/i);

      // Postgres was already anonymised before the ClickHouse timeout fired
      // (Ordering: Postgres first) — a FAILED request must not silently
      // undo that; the request must be retried (idempotently), not the
      // Postgres write.
      const subscriberRow = await fetchSubscriber(subscriberId);
      expect(subscriberRow.appUserId).toMatch(/^anon_/);
    } finally {
      // Always restart merges, even on assertion failure — this is the
      // shared ambient ClickHouse, and leaving merges stopped on
      // raw_exposures would silently stall every other suite touching it.
      await startMerges("raw_exposures");
    }
  }, 30_000);

  it("leaves the subject erased after a later attribute write", async () => {
    // Task 1's guarantee, end to end through the REAL erasure worker (not
    // a hand-crafted soft delete) — mirrors
    // routes/v1/me-dead-ended.integration.test.ts, which proves the same
    // contract against a bare anonymizeSubscriber() call. If Task 1 ever
    // regresses (resolveOrCreateSubscriber stops honoring `deletedAt`),
    // this is what catches it.
    const projectId = await seedProject();
    const appUserId = `erasure-e2e-${nextSuffix()}`;

    const [subscriberRow] = await getDb()
      .insert(schema.subscribers)
      .values({
        projectId,
        rovenueId: appUserId,
        attributes: { $email: { value: "before@example.test", source: "sdk" } },
      })
      .returning();
    if (!subscriberRow) throw new Error("seed: subscriber insert returned no row");

    const publicKey = `rov_pub_${createId()}`;
    await getDb().insert(schema.apiKeys).values({
      projectId,
      label: "dsar-erasure-e2e",
      keyPublic: publicKey,
      keySecretHash: "n/a",
      environment: "PRODUCTION",
    });

    const dsarRequestId = await seedPendingErasureRequest(projectId, subscriberRow.id);
    await seedRawRevenueEvents(projectId, subscriberRow.id);

    const outcome = await runDsarErasure(
      { dsarRequestId, projectId, subscriberId: subscriberRow.id, type: "ERASURE" },
      realDeps(),
    );
    expect(outcome).toEqual({ outcome: "completed" });

    const app = new Hono().use("*", apiKeyAuth("any")).route("/v1/me", meRoute);
    app.onError(errorHandler);

    const before = await fetchSubscriber(subscriberRow.id);

    const res = await app.request("/v1/me/attributes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${publicKey}`,
        "X-Rovenue-App-User-Id": appUserId,
      },
      body: JSON.stringify({ attributes: { $email: "after@example.test" } }),
    });
    expect(res.status).toBe(200);

    const after = await fetchSubscriber(subscriberRow.id);
    expect(after.attributes).toEqual(before.attributes);
    expect(JSON.stringify(after.attributes)).not.toContain("after@example.test");
    expect(after.appUserId).toMatch(/^anon_/);
  }, 30_000);

  it("is idempotent — a second erasure of the same subject is a no-op", async () => {
    // Catches: a worker that errors, double-purges destructively, or
    // corrupts state on a retry / re-submission for an already-erased
    // subject (the dsar_requests uniqueness constraint only blocks a
    // second OPEN request, so a completed request's subject CAN be
    // erased again via a fresh row — a support re-run, a customer
    // re-submitting the same ask).
    const projectId = await seedProject();
    const subscriberId = await seedSubscriber(projectId);
    await seedAllClickHouseTables(projectId, subscriberId);

    const firstRequestId = await seedPendingErasureRequest(projectId, subscriberId);
    const firstOutcome = await runDsarErasure(
      { dsarRequestId: firstRequestId, projectId, subscriberId, type: "ERASURE" },
      realDeps(),
    );
    expect(firstOutcome).toEqual({ outcome: "completed" });

    const anonymousIdAfterFirst = (await fetchSubscriber(subscriberId)).appUserId;

    const secondRequestId = await seedPendingErasureRequest(projectId, subscriberId);
    const secondOutcome = await runDsarErasure(
      { dsarRequestId: secondRequestId, projectId, subscriberId, type: "ERASURE" },
      realDeps(),
    );
    expect(secondOutcome).toEqual({ outcome: "completed" });

    const secondRequest = await fetchRequest(secondRequestId);
    expect(secondRequest.status).toBe("COMPLETED");

    // Deterministic anonymous id — re-running never creates a second
    // shadow identity.
    const anonymousIdAfterSecond = (await fetchSubscriber(subscriberId)).appUserId;
    expect(anonymousIdAfterSecond).toBe(anonymousIdAfterFirst);

    // Still empty — the second run's DELETEs matched zero rows, which is
    // itself a mutation that must still reach is_done = 1 (asserted via
    // the same completed outcome above).
    const counts = await countAllTablesFor(subscriberId);
    for (const table of DSAR_ERASURE_CLICKHOUSE_TABLES) {
      expect(counts[table]).toBe(0);
    }
  }, 60_000);

  it("fails closed when ClickHouse is not configured, before touching Postgres", async () => {
    // Ruling C: a request record that claims erasure while ClickHouse
    // rows remain untouched is worse than no record. This must fail
    // BEFORE Postgres is touched, not after — a partial anonymisation
    // paired with a FAILED request is honest but avoidable when the
    // guard can be checked for free up front.
    const projectId = await seedProject();
    const subscriberId = await seedSubscriber(projectId);
    const dsarRequestId = await seedPendingErasureRequest(projectId, subscriberId);

    const deps = realDeps({ isClickHouseConfigured: () => false });

    const outcome = await runDsarErasure(
      { dsarRequestId, projectId, subscriberId, type: "ERASURE" },
      deps,
    );
    expect(outcome.outcome).toBe("failed");
    if (outcome.outcome === "failed") {
      expect(outcome.error).toMatch(/ClickHouse is not configured/i);
    }
    expect(vi.mocked(deps.anonymizeSubscriber)).not.toHaveBeenCalled();

    const subscriberRow = await fetchSubscriber(subscriberId);
    expect(subscriberRow.deletedAt).toBeNull();

    const finalRequest = await fetchRequest(dsarRequestId);
    expect(finalRequest.status).toBe("FAILED");
  });

  it("writes an audit row for each state change", async () => {
    const projectId = await seedProject();
    const subscriberId = await seedSubscriber(projectId);
    const dsarRequestId = await seedPendingErasureRequest(projectId, subscriberId);

    await runDsarErasure(
      { dsarRequestId, projectId, subscriberId, type: "ERASURE" },
      realDeps(),
    );

    const rows = await getDb()
      .select({ action: schema.auditLogs.action, createdAt: schema.auditLogs.createdAt })
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.resourceId, dsarRequestId));
    const actions = rows
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((r) => r.action);
    expect(actions).toEqual(["dsar_request.claimed", "dsar_request.erasure_completed"]);
  }, 30_000);

  it("does not stay wedged RUNNING when the FAILED transition itself throws (double fault)", async () => {
    // Identical bug and identical fix to dsar-export.integration.test.ts's
    // sibling test (both workers share the exact same claim-work-complete
    // shape and the exact same fix in dsar-requests.ts's claimDsarRequest
    // — see that file's comment for the full mechanism/interval argument).
    //
    // The work throws via the real "ClickHouse not configured" fail-closed
    // path (same as "fails closed when ClickHouse is not configured"
    // above) AND the catch block's own FAILED-transition transaction ALSO
    // throws — injected via `failDsarRequest`, since nothing here can make
    // a real Postgres transaction fail on demand. This is NOT a test of
    // the ordinary failure path (that already passes above); it proves
    // the row does not stay wedged RUNNING after a genuine double fault by
    // simulating a later BullMQ retry — backdating `updatedAt` past
    // DSAR_CLAIM_STALE_RUNNING_MS and calling runDsarErasure again with
    // WORKING deps — and asserting the row reaches FAILED, not a
    // permanent RUNNING.
    const projectId = await seedProject();
    const subscriberId = await seedSubscriber(projectId);
    const dsarRequestId = await seedPendingErasureRequest(projectId, subscriberId);

    const doubleFaultDeps = realDeps({
      isClickHouseConfigured: () => false,
      failDsarRequest: vi.fn(async () => {
        throw new Error("transient db fault while marking FAILED");
      }),
    });

    await expect(
      runDsarErasure(
        { dsarRequestId, projectId, subscriberId, type: "ERASURE" },
        doubleFaultDeps,
      ),
    ).rejects.toThrow(/transient db fault/);

    // The symptom: the double fault leaves the row RUNNING.
    const wedged = await fetchRequest(dsarRequestId);
    expect(wedged.status).toBe("RUNNING");
    const subscriberStillIntact = await fetchSubscriber(subscriberId);
    expect(subscriberStillIntact.deletedAt).toBeNull();

    // Simulate a BullMQ retry long after the claim lease has gone stale.
    await getDb()
      .update(schema.dsarRequests)
      .set({
        updatedAt: new Date(
          Date.now() - drizzle.dsarRequestRepo.DSAR_CLAIM_STALE_RUNNING_MS - 60_000,
        ),
      })
      .where(eq(schema.dsarRequests.id, dsarRequestId));

    const retryOutcome = await runDsarErasure(
      { dsarRequestId, projectId, subscriberId, type: "ERASURE" },
      realDeps({ isClickHouseConfigured: () => false }),
    );

    // Not wedged: the reclaimed retry ran through to a clean terminal
    // FAILED (ClickHouse is still unconfigured), not a permanent RUNNING.
    expect(retryOutcome.outcome).toBe("failed");
    const healed = await fetchRequest(dsarRequestId);
    expect(healed.status).toBe("FAILED");
  }, 30_000);
});
