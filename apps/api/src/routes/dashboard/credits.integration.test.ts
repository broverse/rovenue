// =============================================================
// POST /projects/:projectId/credits — dashboard grant route
//
// Mirrors the pattern of subscriptions.integration.test.ts:
// minimal Hono app mounted on the same path the production tree
// uses, real Postgres seeded inline, real Better Auth session
// cookie so requireDashboardAuth runs unmocked.
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import {
  getDb,
  projects,
  subscribers,
  drizzle,
} from "@rovenue/db";
import { auth } from "../../lib/auth";
import { creditsRoute } from "./credits";
import { isClickHouseConfigured, getClickHouseClient } from "../../lib/clickhouse";

async function seedCurrency(projectId: string, suffix = "") {
  return drizzle.virtualCurrencyRepo.createVirtualCurrency(drizzle.db, {
    projectId,
    code: `GLD${suffix.toUpperCase().replace(/\W/g, "").slice(0, 2)}`,
    name: `Gold${suffix}`,
  });
}

const RUN_ID = Date.now();

function buildApp() {
  return new Hono().route(
    "/projects/:projectId/credits",
    creditsRoute,
  );
}

async function createUserAndSession(suffix: string): Promise<{ userId: string; cookie: string }> {
  const email = `creditsroute_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!creditsroute";
  const name = `Credits Route User ${suffix}`;

  const signUp = await auth.api.signUpEmail({ body: { email, password, name } });
  if (!signUp?.user) throw new Error(`signUpEmail failed for ${suffix}`);

  const signIn = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const cookieHeader = signIn.headers.get("set-cookie");
  if (!cookieHeader) throw new Error(`no set-cookie for ${suffix}`);
  const cookie = cookieHeader.split(";")[0] ?? "";

  return { userId: signUp.user.id, cookie };
}

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_credroute_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Credits Route Project ${RUN_ID}${suffix}`,
  });
  return { id };
}

async function seedMember({
  projectId,
  userId,
  role,
}: {
  projectId: string;
  userId: string;
  role: "OWNER" | "ADMIN" | "DEVELOPER" | "GROWTH" | "CUSTOMER_SUPPORT";
}) {
  await getDb().insert(drizzle.schema.projectMembers).values({
    projectId,
    userId,
    role,
  });
}

async function seedSubscriber({
  projectId,
  suffix = "",
}: {
  projectId: string;
  suffix?: string;
}) {
  const db = getDb();
  const id = `sub_credroute_${RUN_ID}${suffix}`;
  await db.insert(subscribers).values({
    id,
    projectId,
    rovenueId: `app_cred_${RUN_ID}${suffix}`,
    appUserId: `app_cred_${RUN_ID}${suffix}`,
  });
  return { id };
}

const seededProjectIds: string[] = [];
function trackProject(id: string) {
  seededProjectIds.push(id);
  return id;
}

afterAll(async () => {
  const db = getDb();
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

describe("POST /projects/:projectId/credits — manual grant", () => {
  it("appends a BONUS ledger row and returns the new balance", async () => {
    const { userId, cookie } = await createUserAndSession("ok");
    const project = await seedProject("ok");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const sub = await seedSubscriber({ projectId: project.id });
    const currency = await seedCurrency(project.id);

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/credits`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          subscriberId: sub.id,
          currencyId: currency.id,
          amount: 500,
          description: "support comp",
        }),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { balance: number; entry: { type: string; amount: number; currencyId: string } };
    };
    expect(body.data.balance).toBe(500);
    expect(body.data.entry.type).toBe("BONUS");
    expect(body.data.entry.amount).toBe(500);
    expect(body.data.entry.currencyId).toBe(currency.id);

    // ledger row exists in PG
    const cl = drizzle.schema.creditLedger;
    const rows = await getDb()
      .select()
      .from(cl)
      .where(eq(cl.subscriberId, sub.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("BONUS");
    expect(rows[0]?.balance).toBe(500);
    expect(rows[0]?.currencyId).toBe(currency.id);
  });

  it("403s when caller lacks credits:write capability (GROWTH role)", async () => {
    const { userId, cookie } = await createUserAndSession("viewer");
    const project = await seedProject("viewer");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "GROWTH" });
    const sub = await seedSubscriber({ projectId: project.id, suffix: "v" });
    const currency = await seedCurrency(project.id, "v");

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/credits`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ subscriberId: sub.id, currencyId: currency.id, amount: 100 }),
      },
    );

    expect(res.status).toBe(403);
  });

  it("404s when subscriber belongs to a different project", async () => {
    const { userId, cookie } = await createUserAndSession("crossproject");
    const projectA = await seedProject("crossA");
    const projectB = await seedProject("crossB");
    trackProject(projectA.id);
    trackProject(projectB.id);
    await seedMember({ projectId: projectA.id, userId, role: "ADMIN" });
    const subB = await seedSubscriber({ projectId: projectB.id, suffix: "B" });
    const currency = await seedCurrency(projectA.id, "cp");

    const app = buildApp();
    const res = await app.request(
      `/projects/${projectA.id}/credits`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ subscriberId: subB.id, currencyId: currency.id, amount: 50 }),
      },
    );

    expect(res.status).toBe(404);
  });

  it("400s on a non-positive amount", async () => {
    const { userId, cookie } = await createUserAndSession("badamount");
    const project = await seedProject("badamt");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const sub = await seedSubscriber({ projectId: project.id, suffix: "ba" });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/credits`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ subscriberId: sub.id, amount: 0 }),
      },
    );

    expect(res.status).toBe(400);
  });
});

describe("GET /projects/:projectId/credits/rollup — currencyCode filter", () => {
  it("rollup with unknown currencyCode returns 404", async () => {
    const { userId, cookie } = await createUserAndSession("rollup404");
    const project = await seedProject("rollup404");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "CUSTOMER_SUPPORT" });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/credits/rollup?currencyCode=NOPE`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(404);
  });

  it("rollup scoped to a currencyCode only counts that currency's flow", async () => {
    if (!isClickHouseConfigured()) {
      console.log("Skipping CH-scoped volume assertion: ClickHouse not configured");
      return;
    }

    const { userId, cookie } = await createUserAndSession("rollupscoped");
    const project = await seedProject("rollupscoped");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "CUSTOMER_SUPPORT" });
    await seedSubscriber({ projectId: project.id, suffix: "rs" });

    // Seed two distinct currencies — GLD and GEM
    const gld = await drizzle.virtualCurrencyRepo.createVirtualCurrency(drizzle.db, {
      projectId: project.id,
      code: "GLD",
      name: "Gold",
    });
    const gem = await drizzle.virtualCurrencyRepo.createVirtualCurrency(drizzle.db, {
      projectId: project.id,
      code: "GEM",
      name: "Gems",
    });

    const subId = `sub_credroute_${RUN_ID}rs`;
    const testEventIdGld = `evt_test_gld_${RUN_ID}`;
    const testEventIdGem = `evt_test_gem_${RUN_ID}`;

    // Insert directly into raw_credit_ledger in ClickHouse so the query-time
    // view v_credit_consumption_daily picks them up without needing the Kafka
    // outbox pipeline to be running in the test environment.
    // CH DateTime64 requires "YYYY-MM-DD HH:MM:SS.mmm" format (no T/Z).
    const toChDateTime = (d: Date): string =>
      d.toISOString().replace("T", " ").replace("Z", "");
    const now = new Date();
    const nowCh = toChDateTime(now);

    const ch = getClickHouseClient();
    await ch.insert({
      table: "raw_credit_ledger",
      values: [
        {
          eventId: testEventIdGld,
          creditLedgerId: `ledger_gld_${RUN_ID}`,
          projectId: project.id,
          subscriberId: subId,
          currencyId: gld.id,
          type: "BONUS",
          amount: 1000,
          balance: 1000,
          referenceType: "",
          referenceId: "",
          createdAt: nowCh,
          ingestedAt: nowCh,
          _version: Date.now(),
        },
        {
          eventId: testEventIdGem,
          creditLedgerId: `ledger_gem_${RUN_ID}`,
          projectId: project.id,
          subscriberId: subId,
          currencyId: gem.id,
          type: "BONUS",
          amount: 5,
          balance: 5,
          referenceType: "",
          referenceId: "",
          createdAt: nowCh,
          ingestedAt: nowCh,
          _version: Date.now(),
        },
      ],
      format: "JSONEachRow",
    });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/credits/rollup?currencyCode=GEM`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { volume: Array<{ issued: number }> };
    };
    const issued = body.data.volume.reduce(
      (s: number, p: { issued: number }) => s + p.issued,
      0,
    );
    expect(issued).toBe(5);
  });
});
