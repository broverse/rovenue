process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import bcrypt from "bcryptjs";
import { drizzle as drizzleNs } from "@rovenue/db";
import { apiKeyAuth } from "../../middleware/api-key-auth";
import { errorHandler } from "../../middleware/error";
import {
  buildBalancesMap,
  virtualCurrenciesV1Route,
} from "./virtual-currencies";
import { addCredits, getBalance } from "../../services/credit-engine";

// =============================================================
// /v1/virtual-currencies — integration tests
// =============================================================
//
// Boots a minimal Hono app with apiKeyAuth + virtualCurrenciesV1Route
// against live Postgres (docker-compose host port 5433).
//
// Scenarios (HTTP-layer):
//   1. GET /me with PUBLIC key + X-Rovenue-App-User-Id → 200 balances map
//      (this test would fail before Fix 1 — appUserContext was missing)
//   2. POST /:appUserId/:code/transactions with SECRET key, sufficient
//      balance → 200 { code, balance }
//   3. POST with unknown currency code → 404
//   4. POST with insufficient balance → 409
//   5. POST with PUBLIC key (not secret) → 403

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------
const schema = drizzleNs.schema;

let pool: Pool;
let testDb: ReturnType<typeof drizzleClient<typeof drizzleNs.schema>>;

let PROJECT_ID: string;
let PUBLIC_KEY: string;
let SECRET_KEY: string;
let CURRENCY_ID: string;
let SPEND_SUB_INTERNAL_ID: string;

const APP_USER_ID = `u1-vc-${createId().slice(0, 8)}`;
const APP_USER_ID_SPEND = `u2-vc-${createId().slice(0, 8)}`;

// ---------------------------------------------------------------------------
// App under test
// ---------------------------------------------------------------------------
function buildApp() {
  const app = new Hono()
    .use("*", apiKeyAuth("any"))
    .route("/v1/virtual-currencies", virtualCurrenciesV1Route);
  app.onError(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  testDb = drizzleClient(pool, { schema });

  // 1. Seed project
  const [project] = await testDb
    .insert(schema.projects)
    .values({ name: `vc-http-e2e-${createId().slice(0, 8)}` })
    .returning();
  if (!project) throw new Error("seed: project insert returned no row");
  PROJECT_ID = project.id;

  // 2. Seed public API key (matched plain via keyPublic eq)
  PUBLIC_KEY = `rov_pub_${createId()}`;
  await testDb.insert(schema.apiKeys).values({
    projectId: PROJECT_ID,
    label: "test-public-key",
    keyPublic: PUBLIC_KEY,
    keySecretHash: "n/a",
    environment: "PRODUCTION",
  });

  // 3. Seed secret API key.
  //    Token format: rov_sec_<apiKeyId>_<random>
  //    The middleware parses the apiKeyId, fetches by ID, then bcrypt-compares
  //    the full raw token against keySecretHash.
  //    Strategy: pre-generate the row ID so we can embed it in the token
  //    before bcrypt-hashing and inserting.
  const secretRowId = createId();
  const secretRandom = createId();
  SECRET_KEY = `rov_sec_${secretRowId}_${secretRandom}`;
  const secretHash = await bcrypt.hash(SECRET_KEY, 10);
  await testDb.insert(schema.apiKeys).values({
    id: secretRowId,
    projectId: PROJECT_ID,
    label: "test-secret-key",
    keyPublic: `rov_pub_placeholder_${secretRowId}`,
    keySecretHash: secretHash,
    environment: "PRODUCTION",
  });

  // 4. Seed a virtual currency
  const [currency] = await testDb
    .insert(schema.virtualCurrencies)
    .values({
      projectId: PROJECT_ID,
      code: "GEM",
      name: "Gems",
    })
    .returning();
  if (!currency) throw new Error("seed: currency insert returned no row");
  CURRENCY_ID = currency.id;

  // 5. Seed subscriber for GET /me (rovenueId = APP_USER_ID, same as device key)
  await testDb.insert(schema.subscribers).values({
    projectId: PROJECT_ID,
    rovenueId: APP_USER_ID,
  });

  // 6. Seed subscriber for spend tests + grant initial balance
  const [spendSub] = await testDb
    .insert(schema.subscribers)
    .values({
      projectId: PROJECT_ID,
      rovenueId: APP_USER_ID_SPEND,
    })
    .returning();
  if (!spendSub) throw new Error("seed: spend subscriber insert returned no row");
  SPEND_SUB_INTERNAL_ID = spendSub.id;

  // Grant 100 GEMs to the spend subscriber via the credit-engine service
  await addCredits({
    subscriberId: SPEND_SUB_INTERNAL_ID,
    currencyId: CURRENCY_ID,
    amount: 100,
    referenceId: `seed_${createId().slice(0, 8)}`,
  });
}, 30_000);

afterAll(async () => {
  if (PROJECT_ID) {
    // credit_ledger is append-only at the DB level; the cascade delete would
    // be blocked by the trigger unless we set the bypass flag first.
    await drizzleNs.creditLedgerRepo.withLedgerDeleteAuthorized(drizzleNs.db, async (tx) => {
      await tx
        .delete(schema.projects)
        .where(eq(schema.projects.id, PROJECT_ID));
    });
  }
  await pool.end();
});

// ---------------------------------------------------------------------------
// Unit-level helper test (preserved from original)
// ---------------------------------------------------------------------------
describe("v1 virtual-currencies helpers", () => {
  const RUN_ID = Date.now();
  const HELPER_PROJECT_ID = `prj_vcv1_${RUN_ID}`;
  const HELPER_SUB_ID = `sub_vcv1_${RUN_ID}`;

  afterAll(async () => {
    // credit_ledger is append-only; addCredits above created ledger rows so
    // cascade delete needs the bypass flag.
    await drizzleNs.creditLedgerRepo.withLedgerDeleteAuthorized(drizzleNs.db, async (tx) => {
      await tx
        .delete(drizzleNs.schema.projects)
        .where(eq(drizzleNs.schema.projects.id, HELPER_PROJECT_ID));
    });
  });

  it("builds a code-keyed balances map", async () => {
    // Seed project + subscriber
    await drizzleNs.db.insert(drizzleNs.schema.projects).values({
      id: HELPER_PROJECT_ID,
      name: `vc-test-${RUN_ID}`,
    });
    await drizzleNs.db.insert(drizzleNs.schema.subscribers).values({
      id: HELPER_SUB_ID,
      projectId: HELPER_PROJECT_ID,
      rovenueId: `rovid_${RUN_ID}`,
      appUserId: `app_${RUN_ID}`,
    });

    // Seed a virtual currency
    const [emr] = await drizzleNs.db
      .insert(drizzleNs.schema.virtualCurrencies)
      .values({
        projectId: HELPER_PROJECT_ID,
        code: "EMR",
        name: "Emeralds",
      })
      .returning();

    if (!emr) throw new Error("Currency seed failed");

    // Grant some credits
    await addCredits({ subscriberId: HELPER_SUB_ID, currencyId: emr.id, amount: 70 });

    const map = await buildBalancesMap(HELPER_PROJECT_ID, HELPER_SUB_ID);
    expect(map.EMR).toBe(70);
    expect(await getBalance(HELPER_SUB_ID, emr.id)).toBe(70);
  });
});

// ---------------------------------------------------------------------------
// HTTP-layer tests
// ---------------------------------------------------------------------------

describe("GET /v1/virtual-currencies/me", () => {
  it("returns 200 with balances map when PUBLIC key + X-Rovenue-App-User-Id provided", async () => {
    // Grant GEMs to the /me subscriber (resolved via rovenueId == APP_USER_ID)
    const [meSub] = await testDb
      .select({ id: schema.subscribers.id })
      .from(schema.subscribers)
      .where(eq(schema.subscribers.rovenueId, APP_USER_ID));
    if (!meSub) throw new Error("me subscriber not found");

    await addCredits({
      subscriberId: meSub.id,
      currencyId: CURRENCY_ID,
      amount: 50,
      referenceId: `me_${createId().slice(0, 8)}`,
    });

    const app = buildApp();
    const res = await app.request("/v1/virtual-currencies/me", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${PUBLIC_KEY}`,
        "X-Rovenue-App-User-Id": APP_USER_ID,
      },
    });

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as any;
    expect(data.balances).toBeDefined();
    expect(data.balances.GEM).toBeGreaterThanOrEqual(50);
  });
});

describe("POST /v1/virtual-currencies/:appUserId/:code/transactions", () => {
  it("returns 200 with decremented balance when SECRET key + sufficient funds", async () => {
    const app = buildApp();
    const res = await app.request(
      `/v1/virtual-currencies/${APP_USER_ID_SPEND}/GEM/transactions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SECRET_KEY}`,
        },
        body: JSON.stringify({ amount: 10, referenceId: `spend_200_${createId().slice(0, 8)}` }),
      },
    );

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as any;
    expect(data.code).toBe("GEM");
    expect(data.balance).toBe(90);
  });

  it("returns 404 for unknown currency code", async () => {
    const app = buildApp();
    const res = await app.request(
      `/v1/virtual-currencies/${APP_USER_ID_SPEND}/NOPE/transactions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SECRET_KEY}`,
        },
        body: JSON.stringify({ amount: 1, referenceId: `spend_404_${createId().slice(0, 8)}` }),
      },
    );

    expect(res.status).toBe(404);
  });

  it("returns 409 when spending more than the available balance", async () => {
    const app = buildApp();
    const res = await app.request(
      `/v1/virtual-currencies/${APP_USER_ID_SPEND}/GEM/transactions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SECRET_KEY}`,
        },
        body: JSON.stringify({ amount: 99999, referenceId: `spend_409_${createId().slice(0, 8)}` }),
      },
    );

    expect(res.status).toBe(409);
  });

  it("returns 403 when a PUBLIC key is used (secret key required)", async () => {
    const app = buildApp();
    const res = await app.request(
      `/v1/virtual-currencies/${APP_USER_ID_SPEND}/GEM/transactions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${PUBLIC_KEY}`,
        },
        body: JSON.stringify({ amount: 1, referenceId: `spend_403_${createId().slice(0, 8)}` }),
      },
    );

    expect(res.status).toBe(403);
  });

  it("deduplicates: same referenceId posted twice debits the wallet exactly once (W1.3/F3)", async () => {
    // Seed a fresh subscriber with a known balance so this test is fully
    // self-contained and not affected by balance mutations from earlier tests.
    const debitSubRovId = `u3-debit-${createId().slice(0, 8)}`;
    const [debitSub] = await testDb
      .insert(schema.subscribers)
      .values({ projectId: PROJECT_ID, rovenueId: debitSubRovId })
      .returning();
    if (!debitSub) throw new Error("seed: debit subscriber insert returned no row");

    // Grant 100 GEMs so balance is deterministic.
    await addCredits({
      subscriberId: debitSub.id,
      currencyId: CURRENCY_ID,
      amount: 100,
      referenceId: `dedup_seed_${createId().slice(0, 8)}`,
    });

    const DEDUP_REF = `dedup_spend_${createId().slice(0, 12)}`;
    const app = buildApp();

    // First call — should debit 10 GEMs: 100 → 90.
    const res1 = await app.request(
      `/v1/virtual-currencies/${debitSubRovId}/GEM/transactions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SECRET_KEY}`,
        },
        body: JSON.stringify({ amount: 10, referenceId: DEDUP_REF }),
      },
    );
    expect(res1.status).toBe(200);
    const { data: data1 } = (await res1.json()) as any;
    expect(data1.code).toBe("GEM");
    expect(data1.balance).toBe(90);

    // Second call — same referenceId, same amount. Must be idempotent: balance
    // stays at 90 (wallet debited exactly once, not twice).
    const res2 = await app.request(
      `/v1/virtual-currencies/${debitSubRovId}/GEM/transactions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SECRET_KEY}`,
        },
        body: JSON.stringify({ amount: 10, referenceId: DEDUP_REF }),
      },
    );
    expect(res2.status).toBe(200);
    const { data: data2 } = (await res2.json()) as any;
    expect(data2.code).toBe("GEM");
    expect(data2.balance).toBe(90); // still 90 — NOT 80

    // Confirm exactly one SPEND ledger row exists for this referenceId.
    const ledgerRows = await testDb
      .select({ id: schema.creditLedger.id, type: schema.creditLedger.type })
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.referenceId, DEDUP_REF));
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.type).toBe("SPEND");
  });
});
