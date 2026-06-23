// =============================================================
// /v1/offerings — integration tests
// =============================================================
//
// Boots a minimal Hono app with apiKeyAuth + offeringsRoute against
// live Postgres (docker-compose host port 5433).
//
// Scenarios:
//   1. GET / returns offerings with `packages` key (not `products`),
//      each package has `packageIdentifier` (slot id) + `identifier`
//      (product's own id), and offering has no `accessId`.
//   2. GET /:identifier returns matching offering with same shape.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { drizzle as drizzleNs } from "@rovenue/db";
import { apiKeyAuth } from "../../middleware/api-key-auth";
import { offeringsRoute } from "./offerings";

// ---------------------------------------------------------------------------
// Env defaults
// ---------------------------------------------------------------------------
process.env.DATABASE_URL ??= "postgresql://rovenue:rovenue@localhost:5433/rovenue";
process.env.REDIS_URL ??= "redis://localhost:6380";

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------
const schema = drizzleNs.schema;

let pool: Pool;
let testDb: ReturnType<typeof drizzleClient<typeof drizzleNs.schema>>;

let PROJECT_ID: string;
let PUBLIC_KEY: string;
let PRODUCT_ID: string;
let OFFERING_ID: string;

const OFFERING_IDENTIFIER = `test-offering-${createId().slice(0, 8)}`;
const PACKAGE_IDENTIFIER = "$rov_monthly";
const PRODUCT_IDENTIFIER = `prod_monthly_${createId().slice(0, 8)}`;

// ---------------------------------------------------------------------------
// App under test
// ---------------------------------------------------------------------------
function buildApp() {
  return new Hono()
    .use("*", apiKeyAuth("any"))
    .route("/v1/offerings", offeringsRoute);
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
    .values({ name: `offerings-e2e-${createId().slice(0, 8)}` })
    .returning();
  if (!project) throw new Error("seed: project insert returned no row");
  PROJECT_ID = project.id;

  // 2. Seed public API key
  PUBLIC_KEY = `rov_pub_${createId()}`;
  await testDb.insert(schema.apiKeys).values({
    projectId: PROJECT_ID,
    label: "test-public-key",
    keyPublic: PUBLIC_KEY,
    keySecretHash: "n/a",
    environment: "PRODUCTION",
  });

  // 3. Seed a product
  const [product] = await testDb
    .insert(schema.products)
    .values({
      projectId: PROJECT_ID,
      identifier: PRODUCT_IDENTIFIER,
      type: "SUBSCRIPTION",
      displayName: "Monthly Plan",
      isActive: true,
      storeIds: {},
      accessIds: [],
    })
    .returning();
  if (!product) throw new Error("seed: product insert returned no row");
  PRODUCT_ID = product.id;

  // 4. Seed an offering with a package slot pointing to the product
  const [offering] = await testDb
    .insert(schema.offerings)
    .values({
      projectId: PROJECT_ID,
      identifier: OFFERING_IDENTIFIER,
      isDefault: true,
      packages: [
        {
          identifier: PACKAGE_IDENTIFIER,
          productId: PRODUCT_ID,
          order: 0,
          isPromoted: false,
        },
      ],
      metadata: {},
    })
    .returning();
  if (!offering) throw new Error("seed: offering insert returned no row");
  OFFERING_ID = offering.id;
}, 20_000);

afterAll(async () => {
  if (OFFERING_ID) {
    await testDb.delete(schema.offerings).where(eq(schema.offerings.id, OFFERING_ID));
  }
  if (PRODUCT_ID) {
    await testDb.delete(schema.products).where(eq(schema.products.id, PRODUCT_ID));
  }
  if (PROJECT_ID) {
    await testDb.delete(schema.apiKeys).where(eq(schema.apiKeys.projectId, PROJECT_ID));
    await testDb.delete(schema.projects).where(eq(schema.projects.id, PROJECT_ID));
  }
  await pool.end();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /v1/offerings", () => {
  it("includes androidBasePlanId/androidOfferId in offering packages", async () => {
    // The seeded product has no androidBasePlanId/androidOfferId (both null by default).
    // We verify the fields are present on the package with null values (not absent/undefined).
    const app = buildApp();
    const res = await app.request("/v1/offerings", {
      headers: { Authorization: `Bearer ${PUBLIC_KEY}` },
    });
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as any;
    const o = data.offerings.find((x: any) => x.identifier === OFFERING_IDENTIFIER);
    expect(o).toBeDefined();

    const pkg = o.packages[0];
    expect(pkg.androidBasePlanId).toBeNull();
    expect(pkg.androidOfferId).toBeNull();
  });

  it("hydrates packages with packageIdentifier and omits accessId", async () => {
    const app = buildApp();
    const res = await app.request("/v1/offerings", {
      headers: { Authorization: `Bearer ${PUBLIC_KEY}` },
    });
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as any;
    const o = data.offerings.find((x: any) => x.identifier === OFFERING_IDENTIFIER);
    expect(o).toBeDefined();

    // accessId must not appear on the offering
    expect(o.accessId).toBeUndefined();

    // `packages` key (not `products`)
    expect(Array.isArray(o.packages)).toBe(true);
    expect(o.packages).toHaveLength(1);

    const pkg = o.packages[0];
    // packageIdentifier is the RevenueCat-style slot id ($rov_monthly)
    expect(pkg.packageIdentifier).toBe(PACKAGE_IDENTIFIER);
    // identifier is the product's own identifier (additive, non-breaking)
    expect(pkg.identifier).toBe(PRODUCT_IDENTIFIER);
    expect(pkg.identifier).toBeTruthy();

    // `products` key must not appear
    expect(o.products).toBeUndefined();
  });
});

describe("GET /v1/offerings/:identifier", () => {
  it("returns the offering with packages shape and no accessId", async () => {
    const app = buildApp();
    const res = await app.request(`/v1/offerings/${OFFERING_IDENTIFIER}`, {
      headers: { Authorization: `Bearer ${PUBLIC_KEY}` },
    });
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as any;
    expect(data.identifier).toBe(OFFERING_IDENTIFIER);
    expect(data.accessId).toBeUndefined();

    expect(Array.isArray(data.packages)).toBe(true);
    expect(data.packages).toHaveLength(1);

    const pkg = data.packages[0];
    expect(pkg.packageIdentifier).toBe(PACKAGE_IDENTIFIER);
    expect(pkg.identifier).toBe(PRODUCT_IDENTIFIER);

    // `products` key must not appear
    expect(data.products).toBeUndefined();
  });

  it("returns 404 for unknown identifier", async () => {
    const app = buildApp();
    const res = await app.request("/v1/offerings/nonexistent-offering", {
      headers: { Authorization: `Bearer ${PUBLIC_KEY}` },
    });
    expect(res.status).toBe(404);
  });
});
