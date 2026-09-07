// =============================================================
// Migration 0130 — pg_partman registration, proved end to end
// =============================================================
//
// WHAT THIS FILE EXISTS TO CATCH
//
// `revenue_events` and `credit_ledger` were range-partitioned by hand in
// migrations 0015/0016 with 60 monthly children covering 2024-01..2028-12,
// and migration 0019 — the one that hands the rolling window to pg_partman
// — is skipped on every fresh install (see TIMESCALE_LEGACY_TAGS in
// `packages/db/src/fresh-install.ts`). The result was a dated outage: any
// insert on or after 2029-01-01 failed with `no partition of relation
// "revenue_events" found for row`, and nothing anywhere failed earlier to
// warn about it.
//
// Migration 0130 registers both parents starting at the first month the
// hand-made children do not already cover. This suite is the thing that
// keeps that true, and it asserts the USER-VISIBLE fact (a 2029 row can be
// written, into a real partition and not the catch-all default), not just
// the presence of a config row.
//
// WHY A CONTAINER
//
// The migration chain needs pg_partman, which no stock Postgres image has.
// The container is built from `deploy/postgres/` — the same image the
// compose stack and CI run — and `runFreshInstall` then applies the whole
// journal exactly as a fresh self-host does. A mock cannot fail here: the
// only thing that can tell a working `create_parent` from a broken one is
// a real pg_partman.
//
// THIS NEVER TOUCHES A DEVELOPER DATABASE. Both containers are created
// here, bound to ephemeral host ports, and destroyed in afterAll. Nothing
// in this file reads DATABASE_URL.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { Client, Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFreshInstall } from "../src/fresh-install";
import * as schema from "../src/drizzle/schema";
import { ensureRevenueEventPartitions } from "../src/drizzle/repositories/revenue-event-partitions";

const POSTGRES_CONTEXT = fileURLToPath(
  new URL("../../../deploy/postgres/", import.meta.url),
);
const MIGRATION_PATH = new URL(
  "../drizzle/migrations/0130_partman_register_revenue_credit.sql",
  import.meta.url,
);

const PARTMAN_IMAGE_TAG = "rovenue-db-partman-test:latest";
/** Deliberately a stock image: it has no pg_partman, which is the whole
 *  point of the availability-guard assertions below. */
const NO_PARTMAN_IMAGE = "postgres:16-alpine";

const POSTGRES_PORT = 5432;
const POSTGRES_USER = "rovenue";
const POSTGRES_PASSWORD = "rovenue-partman-test";
const POSTGRES_DB = "rovenue_partman_test";

/** The postgres entrypoint starts the server once for initdb and again for
 *  real, so the readiness line appears twice. */
const READY_LOG_OCCURRENCES = 2;
const CONTAINER_STARTUP_MS = 300_000;
/** Building the image and replaying ~130 migrations dominates this. */
const SETUP_TIMEOUT_MS = 900_000;
const TEST_TIMEOUT_MS = 120_000;

const REVENUE_EVENTS = "revenue_events";
const CREDIT_LEDGER = "credit_ledger";
/** Registered by 0130. Index-aligned with nothing else — the pair is
 *  asserted as a set, so `outgoing_webhooks` sneaking in is a failure. */
const REGISTERED_PARENTS = [
  `public.${REVENUE_EVENTS}`,
  `public.${CREDIT_LEDGER}`,
] as const;
/** Deliberately NOT registered: its retention predicate is composite
 *  (status AND age) and a hand-rolled worker owns it. */
const UNREGISTERED_PARENT = "public.outgoing_webhooks";
/** Registered by earlier migrations (0051/0060) WITH partman retention.
 *  0130 must not touch these. */
const FOREIGN_PARENT_RETENTION: Readonly<Record<string, string>> = {
  "public.funnel_sessions": "18 months",
  "public.funnel_answers": "18 months",
  "public.integration_deliveries": "30 days",
};

/** 0019's intent, carried forward. */
const EXPECTED_PREMAKE = 12;
/** The last month migrations 0015/0016 create by hand; 0130 must start
 *  partman at the month after it. */
const FIRST_PARTMAN_MONTH = "2029-01-01";
/** partman v5 child naming for FIRST_PARTMAN_MONTH. */
const FIRST_PARTMAN_SUFFIX = "p20290101";
/** The insert that failed before 0130. This is the defect. */
const CLIFF_TIMESTAMP = "2029-01-01 00:00:00+00";

const PROJECT_ID = "proj_partman_test";
const USER_ID = "user_partman_test";
const SUBSCRIBER_ID = "sub_partman_test";
const PRODUCT_ID = "prod_partman_test";
const PURCHASE_ID = "purch_partman_test";
const CURRENCY_ID = "vc_partman_test";

/** A month INSIDE the 2024-01..2028-12 range migrations 0015/0016 already
 *  covered by hand. Provisioning it must be a no-op: partman would name its
 *  child `revenue_events_p20260301` and, because its existence check is by
 *  NAME, would try to attach it over the range `revenue_events_2026_03`
 *  already owns. That is today's data, not a 2029 edge case. */
const HAND_MADE_MONTH = "2026-03-01 00:00:00+00";
const HAND_MADE_MONTH_CHILD = `${REVENUE_EVENTS}_2026_03`;
/** What partman WOULD have created for HAND_MADE_MONTH. Must never exist. */
const HAND_MADE_MONTH_PARTMAN_CHILD = `${REVENUE_EVENTS}_p20260301`;
/** A row inside HAND_MADE_MONTH, to prove the hand-made child still takes it. */
const HAND_MADE_MONTH_ROW = "2026-03-15 00:00:00+00";

/** BELOW the hand-made range and below partman's registered start, with no
 *  existing child at all — partman creates a month behind its own window. */
const UNCOVERED_PAST_MONTH = "2019-06-01 00:00:00+00";
const UNCOVERED_PAST_CHILD = `${REVENUE_EVENTS}_p20190601`;

/** At/after the registered start and beyond the premake horizon. */
const UNCOVERED_FUTURE_MONTH = "2030-05-01 00:00:00+00";
const UNCOVERED_FUTURE_CHILD = `${REVENUE_EVENTS}_p20300501`;

let container: StartedTestContainer;
let pool: Pool;
let db: ReturnType<typeof drizzleClient<typeof schema>>;

async function startPostgres(
  image: GenericContainer,
): Promise<StartedTestContainer> {
  return image
    .withEnvironment({ POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB })
    .withExposedPorts(POSTGRES_PORT)
    .withWaitStrategy(
      Wait.forLogMessage(
        /database system is ready to accept connections/,
        READY_LOG_OCCURRENCES,
      ),
    )
    .withStartupTimeout(CONTAINER_STARTUP_MS)
    .start();
}

function connectionStringFor(started: StartedTestContainer): string {
  return (
    `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@` +
    `${started.getHost()}:${started.getMappedPort(POSTGRES_PORT)}/${POSTGRES_DB}`
  );
}

/** Foreign keys on `revenue_events` and `credit_ledger` reach projects,
 *  subscribers, products, purchases and virtual_currencies, so the cliff
 *  insert needs a real row behind each one. Without them a failing insert
 *  could be an FK violation dressed up as proof. */
async function seedForeignKeyRows(): Promise<void> {
  await pool.query(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'Partman Test', 'partman@example.test', true, now(), now())`,
    [USER_ID],
  );
  await pool.query(`INSERT INTO projects (id, name) VALUES ($1, 'Partman')`, [
    PROJECT_ID,
  ]);
  await pool.query(
    `INSERT INTO subscribers (id, "projectId", "rovenueId") VALUES ($1, $2, $3)`,
    [SUBSCRIBER_ID, PROJECT_ID, "rov_partman_test"],
  );
  await pool.query(
    `INSERT INTO products (id, "projectId", identifier, type, "storeIds", "displayName")
     VALUES ($1, $2, 'prod.partman', 'SUBSCRIPTION', '{}'::jsonb, 'Partman Product')`,
    [PRODUCT_ID, PROJECT_ID],
  );
  await pool.query(
    `INSERT INTO purchases (id, "projectId", "subscriberId", "productId", store,
                            "storeTransactionId", "originalTransactionId", status,
                            "purchaseDate", "originalPurchaseDate", environment)
     VALUES ($1, $2, $3, $4, 'APP_STORE', 'tx_partman', 'tx_partman', 'ACTIVE',
             now(), now(), 'PRODUCTION')`,
    [PURCHASE_ID, PROJECT_ID, SUBSCRIBER_ID, PRODUCT_ID],
  );
  await pool.query(
    `INSERT INTO virtual_currencies (id, "projectId", code, name)
     VALUES ($1, $2, 'GEM', 'Gems')`,
    [CURRENCY_ID, PROJECT_ID],
  );
}

/** Which physical child a row actually landed in. `tableoid::regclass` is
 *  the only answer Postgres will give that cannot be inferred from the
 *  insert succeeding — which is what distinguishes "there is a partition
 *  for 2029" from "it fell into the catch-all default". */
async function childHolding(
  table: string,
  idColumn: string,
  id: string,
): Promise<string> {
  const { rows } = await pool.query<{ child: string }>(
    `SELECT tableoid::regclass::text AS child FROM ${table} WHERE ${idColumn} = $1`,
    [id],
  );
  return rows[0]?.child ?? "";
}

async function relationExists(qualifiedName: string): Promise<boolean> {
  const { rows } = await pool.query<{ present: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [qualifiedName],
  );
  return rows[0]?.present === true;
}

async function childCount(parent: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_inherits i
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = $1`,
    [parent],
  );
  return Number(rows[0]?.count ?? "0");
}

beforeAll(async () => {
  const image = await GenericContainer.fromDockerfile(POSTGRES_CONTEXT).build(
    PARTMAN_IMAGE_TAG,
    { deleteOnExit: false },
  );
  container = await startPostgres(image);
  pool = new Pool({ connectionString: connectionStringFor(container) });
  db = drizzleClient(pool, { schema });

  const client = await pool.connect();
  try {
    await runFreshInstall(client);
  } finally {
    client.release();
  }

  await seedForeignKeyRows();
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("migration 0130 — partman registration", () => {
  it(
    "registers exactly revenue_events and credit_ledger",
    async () => {
      const { rows } = await pool.query<{ parent_table: string }>(
        `SELECT parent_table FROM partman.part_config ORDER BY parent_table`,
      );
      const registered = rows.map((r) => r.parent_table);
      for (const parent of REGISTERED_PARENTS) {
        expect(registered, `${parent} must be partman-managed`).toContain(
          parent,
        );
      }
      // 0019's own comment says outgoing_webhooks stays out; that decision
      // must survive this migration.
      expect(registered).not.toContain(UNREGISTERED_PARENT);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "registers for PREMAKE ONLY — partman's own retention stays disabled",
    async () => {
      // apps/api/src/workers/retention-sweep.ts owns dropping these two
      // tables (strategy DROP_PARTITION in
      // packages/shared/src/retention/policies.ts). It drops only at the
      // longest window any project resolved, only when every project
      // resolved one, and writes a per-project audit row first. A partman
      // `retention` here would be a second, unconditional, unaudited
      // dropper racing it.
      const { rows } = await pool.query<{
        parent_table: string;
        retention: string | null;
        premake: number;
        infinite_time_partitions: boolean;
        partition_interval: string;
      }>(
        `SELECT parent_table, retention, premake, infinite_time_partitions,
                partition_interval
           FROM partman.part_config
          WHERE parent_table = ANY($1::text[])
          ORDER BY parent_table`,
        [[...REGISTERED_PARENTS]],
      );
      expect(rows).toHaveLength(REGISTERED_PARENTS.length);
      for (const row of rows) {
        expect(row.retention, `${row.parent_table} retention`).toBeNull();
        expect(row.premake).toBe(EXPECTED_PREMAKE);
        // Premake behaviour, not retention: keep making children even when
        // the newest data is older than now.
        expect(row.infinite_time_partitions).toBe(true);
        expect(row.partition_interval).toContain("mon");
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "leaves the parents registered by earlier migrations alone",
    async () => {
      const { rows } = await pool.query<{
        parent_table: string;
        retention: string | null;
      }>(
        `SELECT parent_table, retention FROM partman.part_config
          WHERE parent_table = ANY($1::text[]) ORDER BY parent_table`,
        [Object.keys(FOREIGN_PARENT_RETENTION)],
      );
      const actual = Object.fromEntries(
        rows.map((r) => [r.parent_table, r.retention]),
      );
      expect(actual).toEqual(FOREIGN_PARENT_RETENTION);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "starts partman at the first month the hand-made children do not cover",
    async () => {
      for (const parent of REGISTERED_PARENTS) {
        const table = parent.replace("public.", "");
        const { rows } = await pool.query<{ bound: string }>(
          `SELECT pg_get_expr(c.relpartbound, c.oid) AS bound
             FROM pg_inherits i
             JOIN pg_class p ON p.oid = i.inhparent
             JOIN pg_class c ON c.oid = i.inhrelid
            WHERE p.relname = $1 AND c.relname = $2`,
          [table, `${table}_${FIRST_PARTMAN_SUFFIX}`],
        );
        expect(rows, `${table} is missing its first partman child`).toHaveLength(
          1,
        );
        expect(rows[0]?.bound).toContain(FIRST_PARTMAN_MONTH);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reads the legacy _YYYY_MM children from the catalog, not by name",
    async () => {
      // The split naming (`_YYYY_MM` from 0015/0016, `_pYYYYMMDD` from
      // partman) is the reason 0019 was skipped in the first place. partman
      // resolves a set's last partition from pg_inherits + relpartbound, so
      // the differently-named children are visible to it and the newest one
      // it sees is the one IT just made — which is what makes maintenance
      // continue past 2028-12 instead of trying to remake 2024.
      const { rows } = await pool.query<{ partition_tablename: string }>(
        `SELECT partition_tablename
           FROM partman.show_partitions($1, 'DESC')`,
        [REGISTERED_PARENTS[0]],
      );
      // 60 hand-made months + the one partman created.
      expect(rows.length).toBe(61);
      expect(rows[0]?.partition_tablename).toBe(
        `${REVENUE_EVENTS}_${FIRST_PARTMAN_SUFFIX}`,
      );
      expect(rows.map((r) => r.partition_tablename)).toContain(
        `${REVENUE_EVENTS}_2024_01`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "accepts the insert that used to have nowhere to go, into a real partition",
    async () => {
      await pool.query(
        `INSERT INTO revenue_events
           (id, "projectId", "subscriberId", "purchaseId", type, amount, currency,
            "amountUsd", store, "productId", "eventDate")
         VALUES ('re_cliff', $1, $2, $3, 'RENEWAL', 9.99, 'USD', 9.99,
                 'APP_STORE', $4, $5::timestamptz)`,
        [PROJECT_ID, SUBSCRIBER_ID, PURCHASE_ID, PRODUCT_ID, CLIFF_TIMESTAMP],
      );
      await pool.query(
        `INSERT INTO credit_ledger
           (id, "projectId", "subscriberId", type, amount, balance, "currencyId", "createdAt")
         VALUES ('cl_cliff', $1, $2, 'BONUS', 10, 10, $3, $4::timestamptz)`,
        [PROJECT_ID, SUBSCRIBER_ID, CURRENCY_ID, CLIFF_TIMESTAMP],
      );

      // Landing in `<table>_default` would also have made the INSERT
      // succeed while leaving the partition set just as broken, so assert
      // the physical child by name.
      expect(await childHolding(REVENUE_EVENTS, "id", "re_cliff")).toBe(
        `${REVENUE_EVENTS}_${FIRST_PARTMAN_SUFFIX}`,
      );
      expect(await childHolding(CREDIT_LEDGER, "id", "cl_cliff")).toBe(
        `${CREDIT_LEDGER}_${FIRST_PARTMAN_SUFFIX}`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "re-running the migration is a no-op",
    async () => {
      // Upgrade-path databases already ran 0019 and already hold both
      // parents. Re-registering must not error and must not duplicate.
      const sql = readFileSync(MIGRATION_PATH, "utf8");
      const before = await childCount(REVENUE_EVENTS);
      await pool.query(sql);
      await pool.query(sql);
      expect(await childCount(REVENUE_EVENTS)).toBe(before);

      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM partman.part_config
          WHERE parent_table = ANY($1::text[])`,
        [[...REGISTERED_PARENTS]],
      );
      expect(Number(rows[0]?.count)).toBe(REGISTERED_PARENTS.length);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "clears the 7-year retention that 0019 left on upgrade-path databases",
    async () => {
      // Simulate the state a production database is in: 0019 ran, so
      // partman holds a retention window that now duplicates (and outranks
      // nothing in) the retention sweep. Applying 0130 must take it away.
      await pool.query(
        `UPDATE partman.part_config
            SET retention = '7 years',
                retention_keep_table = false,
                retention_keep_index = false
          WHERE parent_table = ANY($1::text[])`,
        [[...REGISTERED_PARENTS]],
      );
      await pool.query(readFileSync(MIGRATION_PATH, "utf8"));

      const { rows } = await pool.query<{
        parent_table: string;
        retention: string | null;
        retention_keep_table: boolean;
        retention_keep_index: boolean;
      }>(
        `SELECT parent_table, retention, retention_keep_table, retention_keep_index
           FROM partman.part_config WHERE parent_table = ANY($1::text[])`,
        [[...REGISTERED_PARENTS]],
      );
      for (const row of rows) {
        expect(row.retention, `${row.parent_table} retention`).toBeNull();
        // Back to partman's own defaults, so nothing reads as armed.
        expect(row.retention_keep_table).toBe(true);
        expect(row.retention_keep_index).toBe(true);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// =============================================================
// The provisioner that RUNS ON TOP of 0130's registration
// =============================================================
//
// `ensureMonthlyPartitions` picks pg_partman's `create_partition_time` for
// any parent in `partman.part_config`. Since 0130 that is BOTH install
// paths, so the provisioner now takes the partman branch against a table
// that also carries 60 hand-made `_YYYY_MM` children. partman's existence
// check is by child NAME, so for a month those children already cover it
// proposes `revenue_events_pYYYYMMDD` and Postgres rejects the attach with
// the very overlap error 0130's own header quotes.
//
// Every partman-branch test that existed before this block used a month
// BELOW 2024 — the safe case. The changed case (a month inside
// 2024-01..2028-12, i.e. today's data) was never exercised anywhere. These
// three tests cover all three positions a month can occupy relative to the
// hand-made range and the registered start.

describe("ensureRevenueEventPartitions on a 0130-registered parent", () => {
  it(
    "is a no-op for a month the hand-made 0015 children already cover",
    async () => {
      expect(
        await relationExists(`public.${HAND_MADE_MONTH_CHILD}`),
        `${HAND_MADE_MONTH_CHILD} is the premise of this test`,
      ).toBe(true);

      await ensureRevenueEventPartitions(db, {
        minEventDate: new Date(HAND_MADE_MONTH),
        maxEventDate: new Date(HAND_MADE_MONTH),
      });

      // Nothing new, and specifically not the overlapping partman-named
      // child — its creation is what raises
      // `would overlap partition "revenue_events_2026_03"`.
      expect(
        await relationExists(`public.${HAND_MADE_MONTH_PARTMAN_CHILD}`),
      ).toBe(false);
      expect(await relationExists(`public.${HAND_MADE_MONTH_CHILD}`)).toBe(true);

      // And the month is genuinely usable afterwards, in the hand-made child.
      await pool.query(
        `INSERT INTO revenue_events
           (id, "projectId", "subscriberId", "purchaseId", type, amount, currency,
            "amountUsd", store, "productId", "eventDate")
         VALUES ('re_handmade', $1, $2, $3, 'RENEWAL', 1.99, 'USD', 1.99,
                 'APP_STORE', $4, $5::timestamptz)`,
        [
          PROJECT_ID,
          SUBSCRIBER_ID,
          PURCHASE_ID,
          PRODUCT_ID,
          HAND_MADE_MONTH_ROW,
        ],
      );
      expect(await childHolding(REVENUE_EVENTS, "id", "re_handmade")).toBe(
        HAND_MADE_MONTH_CHILD,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "creates a month BELOW the registered start that no child covers",
    async () => {
      expect(await relationExists(`public.${UNCOVERED_PAST_CHILD}`)).toBe(false);

      await ensureRevenueEventPartitions(db, {
        minEventDate: new Date(UNCOVERED_PAST_MONTH),
        maxEventDate: new Date(UNCOVERED_PAST_MONTH),
      });

      expect(await relationExists(`public.${UNCOVERED_PAST_CHILD}`)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "creates a month at/after the registered start beyond partman's premake",
    async () => {
      expect(await relationExists(`public.${UNCOVERED_FUTURE_CHILD}`)).toBe(
        false,
      );

      await ensureRevenueEventPartitions(db, {
        minEventDate: new Date(UNCOVERED_FUTURE_MONTH),
        maxEventDate: new Date(UNCOVERED_FUTURE_MONTH),
      });

      expect(await relationExists(`public.${UNCOVERED_FUTURE_CHILD}`)).toBe(
        true,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "spans a range that crosses from uncovered months into covered ones",
    async () => {
      // The realistic import shape: a file whose dates straddle the edge of
      // the hand-made range. Every month must end up provisioned, and the
      // covered ones must be left exactly as they were.
      await ensureRevenueEventPartitions(db, {
        minEventDate: new Date("2023-11-05 00:00:00+00"),
        maxEventDate: new Date("2024-02-05 00:00:00+00"),
      });

      expect(await relationExists(`public.${REVENUE_EVENTS}_p20231101`)).toBe(
        true,
      );
      expect(await relationExists(`public.${REVENUE_EVENTS}_p20231201`)).toBe(
        true,
      );
      expect(await relationExists(`public.${REVENUE_EVENTS}_2024_01`)).toBe(
        true,
      );
      expect(await relationExists(`public.${REVENUE_EVENTS}_p20240101`)).toBe(
        false,
      );
      expect(await relationExists(`public.${REVENUE_EVENTS}_p20240201`)).toBe(
        false,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is idempotent across all three positions",
    async () => {
      const before = await childCount(REVENUE_EVENTS);
      await ensureRevenueEventPartitions(db, {
        minEventDate: new Date(UNCOVERED_PAST_MONTH),
        maxEventDate: new Date(UNCOVERED_PAST_MONTH),
      });
      await ensureRevenueEventPartitions(db, {
        minEventDate: new Date(HAND_MADE_MONTH),
        maxEventDate: new Date(HAND_MADE_MONTH),
      });
      await ensureRevenueEventPartitions(db, {
        minEventDate: new Date(UNCOVERED_FUTURE_MONTH),
        maxEventDate: new Date(UNCOVERED_FUTURE_MONTH),
      });
      expect(await childCount(REVENUE_EVENTS)).toBe(before);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("migration 0130 — availability guard", () => {
  let bareContainer: StartedTestContainer | undefined;

  afterAll(async () => {
    await bareContainer?.stop();
  });

  it(
    "skips loudly, naming the consequence, when pg_partman is unavailable",
    async () => {
      // A guard that cannot fail and reads identically to success is the
      // exact defect class this batch exists to remove. So this asserts the
      // operator-visible NOTICE, not merely that nothing threw.
      bareContainer = await startPostgres(
        new GenericContainer(NO_PARTMAN_IMAGE),
      );
      const client = new Client({
        connectionString: connectionStringFor(bareContainer),
      });
      const notices: string[] = [];
      client.on("notice", (n) => notices.push(n.message ?? ""));
      await client.connect();
      try {
        await client.query(readFileSync(MIGRATION_PATH, "utf8"));
      } finally {
        await client.end();
      }

      const skip = notices.find((n) => n.includes("0130 SKIPPED"));
      expect(skip, `notices seen: ${JSON.stringify(notices)}`).toBeDefined();
      // The consequence, in the message, in words an operator can act on.
      expect(skip).toContain("pg_partman");
      expect(skip).toContain(REGISTERED_PARENTS[0]);
      expect(skip).toContain(REGISTERED_PARENTS[1]);
      expect(skip).toContain("no partition of relation");
      expect(skip).toContain("2028-12");
      // And it must be distinguishable from the success path, whose notice
      // opens "0130: registered <table> with pg_partman".
      expect(notices.some((n) => n.includes("0130: registered"))).toBe(false);
    },
    SETUP_TIMEOUT_MS,
  );
});
