// =============================================================
// listSubscribers — country filter integration test
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).
// Pattern mirrors the sibling resolve / identity integration suites.
//
// Task 6 of the subscriber-attributes backend plan: the country filter
// must read the NESTED attribute value (`->'country'->>'value'`) rather
// than the flat top-level string (`->>'country'`).

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../client";
import { projects, subscribers } from "../schema";
import { listSubscribers } from "./subscribers";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_country_filter_${RUN_ID}`;

describe("listSubscribers — nested country attribute filter", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `CountryFilter ${RUN_ID}` });
  });

  afterAll(async () => {
    const db = getDb();
    await db.delete(subscribers).where(eq(subscribers.projectId, PROJECT_ID));
    await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("filters by nested country attribute value", async () => {
    const db = getDb();

    // arrange: insert two subscribers with nested country attributes
    await db.insert(subscribers).values([
      {
        projectId: PROJECT_ID,
        rovenueId: `r-us-${RUN_ID}`,
        attributes: {
          country: { value: "US", updatedAt: "2026-06-15T00:00:00.000Z", source: "sdk" },
        },
      },
      {
        projectId: PROJECT_ID,
        rovenueId: `r-tr-${RUN_ID}`,
        attributes: {
          country: { value: "TR", updatedAt: "2026-06-15T00:00:00.000Z", source: "sdk" },
        },
      },
    ]);

    const rows = await listSubscribers(db, { projectId: PROJECT_ID, limit: 50, country: "us" });

    expect(
      rows.some(
        (r) =>
          r.attributes !== null &&
          (r.attributes as Record<string, { value: string }>).country?.value === "US",
      ),
    ).toBe(true);

    expect(
      rows.every(
        (r) =>
          (r.attributes as Record<string, { value: string }>)?.country?.value !== "TR",
      ),
    ).toBe(true);
  });

  it("is case-insensitive — lowercase country code matches stored uppercase value", async () => {
    const db = getDb();

    await db.insert(subscribers).values({
      projectId: PROJECT_ID,
      rovenueId: `r-de-${RUN_ID}`,
      attributes: {
        country: { value: "DE", updatedAt: "2026-06-15T00:00:00.000Z", source: "sdk" },
      },
    });

    const rows = await listSubscribers(db, { projectId: PROJECT_ID, limit: 50, country: "de" });

    expect(
      rows.some(
        (r) =>
          (r.attributes as Record<string, { value: string }>)?.country?.value === "DE",
      ),
    ).toBe(true);
  });
});
