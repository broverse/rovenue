process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import { getInstallsDaily } from "./installs";

// Real Postgres, deliberately: `rev_per_install`'s denominator is a
// Postgres fact, so the ClickHouse schema-contract harness cannot guard
// it (same position as `trials_started` / `churn` — see ROADMAP §5's
// standing note). This file is that guard.

const RUN_ID = Date.now();
const PROJECT_ID = `prj_instd_${RUN_ID}`;
const DAY_ONE = new Date("2026-03-02T10:00:00.000Z");
const DAY_ONE_LATER = new Date("2026-03-02T23:30:00.000Z");
const DAY_TWO = new Date("2026-03-03T01:00:00.000Z");
const FROM = new Date("2026-03-01T00:00:00.000Z");
const TO = new Date("2026-03-04T23:59:59.999Z");

describe("getInstallsDaily", () => {
  afterAll(async () => {
    await drizzle.db
      .delete(drizzle.schema.projects)
      .where(eq(drizzle.schema.projects.id, PROJECT_ID));
  });

  it("counts only SDK-created rows, grouped by install day", async () => {
    await drizzle.db
      .insert(drizzle.schema.projects)
      .values({ id: PROJECT_ID, name: `INSTD ${RUN_ID}` });
    await drizzle.db.insert(drizzle.schema.subscribers).values([
      {
        projectId: PROJECT_ID,
        rovenueId: `a_${RUN_ID}`,
        sdkInstalledAt: DAY_ONE,
      },
      {
        projectId: PROJECT_ID,
        rovenueId: `b_${RUN_ID}`,
        sdkInstalledAt: DAY_ONE_LATER,
      },
      {
        projectId: PROJECT_ID,
        rovenueId: `c_${RUN_ID}`,
        sdkInstalledAt: DAY_TWO,
      },
      // Importer-created: no sdkInstalledAt. Must NOT be counted — this
      // is the assertion that makes the metric mean what it says.
      { projectId: PROJECT_ID, rovenueId: `d_${RUN_ID}` },
    ]);

    const rows = await getInstallsDaily({
      projectId: PROJECT_ID,
      from: FROM,
      to: TO,
    });
    expect(rows).toEqual([
      { day: "2026-03-02", n: 2 },
      { day: "2026-03-03", n: 1 },
    ]);
  });

  it("keeps counting an anonymized subscriber's install", async () => {
    await drizzle.db.insert(drizzle.schema.subscribers).values({
      projectId: PROJECT_ID,
      rovenueId: `e_${RUN_ID}`,
      sdkInstalledAt: DAY_TWO,
      // What anonymize-subscriber leaves behind: attributes cleared,
      // deletedAt stamped. The install must survive it.
      deletedAt: new Date(),
      attributes: {},
    });
    const rows = await getInstallsDaily({
      projectId: PROJECT_ID,
      from: FROM,
      to: TO,
    });
    expect(rows.find((r) => r.day === "2026-03-03")?.n).toBe(2);
  });

  it("excludes installs outside the window", async () => {
    const rows = await getInstallsDaily({
      projectId: PROJECT_ID,
      from: new Date("2026-03-03T00:00:00.000Z"),
      to: TO,
    });
    expect(rows.map((r) => r.day)).toEqual(["2026-03-03"]);
  });

  it("scopes to the project", async () => {
    const rows = await getInstallsDaily({
      projectId: `${PROJECT_ID}_other`,
      from: FROM,
      to: TO,
    });
    expect(rows).toEqual([]);
  });
});
