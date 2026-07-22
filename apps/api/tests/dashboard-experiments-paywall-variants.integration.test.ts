// =============================================================
// Dashboard experiments — PAYWALL variant enforcement
//
// PAYWALL-type experiments reference paywalls by id: every variant's
// `value` must be `{ paywallId }` and that id must belong to the
// project. Mirrors the bootstrap in dashboard-paywalls.integration.test.ts
// (real Postgres, real Better Auth session).
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, projects, drizzle } from "@rovenue/db";
import { auth } from "../src/lib/auth";
import { errorHandler } from "../src/middleware/error";
import { experimentsRoute } from "../src/routes/dashboard/experiments";

const RUN_ID = Date.now();

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app.route("/experiments", experimentsRoute);
}

async function createUserAndSession(
  suffix: string,
): Promise<{ userId: string; cookie: string }> {
  const email = `expvariants_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!expvariants";
  const name = `Exp Variants User ${suffix}`;

  const signUp = await auth.api.signUpEmail({ body: { email, password, name } });
  if (!signUp?.user?.id) throw new Error("signUp failed");

  const signIn = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const rawCookie = signIn.headers.get("set-cookie") ?? "";
  const cookie = rawCookie.split(",").map((s) => s.trim().split(";")[0]).join("; ");
  return { userId: signUp.user.id, cookie };
}

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_expvar_${RUN_ID}${suffix}`;
  await db.insert(projects).values({ id, name: `Exp Variants Project ${RUN_ID}${suffix}` });
  return { id };
}

async function seedMember({
  projectId,
  userId,
  role,
}: {
  projectId: string;
  userId: string;
  role: "OWNER" | "ADMIN" | "CUSTOMER_SUPPORT";
}) {
  await getDb().insert(drizzle.schema.projectMembers).values({ projectId, userId, role });
}

async function seedOffering(projectId: string, suffix = "") {
  const db = getDb();
  const [row] = await db
    .insert(drizzle.schema.offerings)
    .values({ projectId, identifier: `offering_${RUN_ID}${suffix}`, packages: [] })
    .returning();
  return { id: row!.id };
}

async function seedPaywall(projectId: string, offeringId: string, suffix = "") {
  const db = getDb();
  const [row] = await db
    .insert(drizzle.schema.paywalls)
    .values({
      projectId,
      identifier: `paywall_${RUN_ID}${suffix}`,
      name: `Paywall ${suffix}`,
      offeringId,
      remoteConfig: { defaultLocale: "en", locales: { en: { title: "x" } } },
    })
    .returning();
  return { id: row!.id };
}

async function seedAudience(projectId: string, suffix = "") {
  const db = getDb();
  const [row] = await db
    .insert(drizzle.schema.audiences)
    .values({ projectId, name: `Audience ${RUN_ID}${suffix}`, rules: {} })
    .returning();
  return { id: row!.id };
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

describe("POST /experiments — PAYWALL variant enforcement", () => {
  it("creates a PAYWALL experiment when every variant references an owned paywall", async () => {
    const { userId, cookie } = await createUserAndSession("create-ok");
    const project = await seedProject("create-ok");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "create-ok");
    const paywallA = await seedPaywall(project.id, offering.id, "create-ok-a");
    const paywallB = await seedPaywall(project.id, offering.id, "create-ok-b");
    const audience = await seedAudience(project.id, "create-ok");

    const app = buildApp();
    const res = await app.request("/experiments", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        projectId: project.id,
        name: "Paywall Experiment",
        type: "PAYWALL",
        audienceId: audience.id,
        variants: [
          { id: "a", name: "A", value: { paywallId: paywallA.id }, weight: 0.5 },
          { id: "b", name: "B", value: { paywallId: paywallB.id }, weight: 0.5 },
        ],
      }),
    });
    expect(res.status).toBe(200);
  });

  it("400s when a PAYWALL variant is missing value.paywallId", async () => {
    const { userId, cookie } = await createUserAndSession("create-missing");
    const project = await seedProject("create-missing");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const audience = await seedAudience(project.id, "create-missing");

    const app = buildApp();
    const res = await app.request("/experiments", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        projectId: project.id,
        name: "Paywall Experiment Missing",
        type: "PAYWALL",
        audienceId: audience.id,
        variants: [
          { id: "a", name: "A", value: { notPaywallId: "x" }, weight: 0.5 },
          { id: "b", name: "B", value: { paywallId: "whatever" }, weight: 0.5 },
        ],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("400s when a PAYWALL variant references a paywall from another project", async () => {
    const { userId, cookie } = await createUserAndSession("create-foreign");
    const project = await seedProject("create-foreign");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const audience = await seedAudience(project.id, "create-foreign");

    const otherProject = await seedProject("create-foreign-other");
    trackProject(otherProject.id);
    const otherOffering = await seedOffering(otherProject.id, "create-foreign-other");
    const otherPaywall = await seedPaywall(otherProject.id, otherOffering.id, "create-foreign-other");

    const app = buildApp();
    const res = await app.request("/experiments", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        projectId: project.id,
        name: "Paywall Experiment Foreign",
        type: "PAYWALL",
        audienceId: audience.id,
        variants: [
          { id: "a", name: "A", value: { paywallId: otherPaywall.id }, weight: 0.5 },
          { id: "b", name: "B", value: { paywallId: "does-not-exist" }, weight: 0.5 },
        ],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("does not break non-PAYWALL (FLAG) experiment writes", async () => {
    const { userId, cookie } = await createUserAndSession("flag-ok");
    const project = await seedProject("flag-ok");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const audience = await seedAudience(project.id, "flag-ok");

    const app = buildApp();
    const res = await app.request("/experiments", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        projectId: project.id,
        name: "Flag Experiment",
        type: "FLAG",
        audienceId: audience.id,
        variants: [
          { id: "a", name: "A", value: true, weight: 0.5 },
          { id: "b", name: "B", value: false, weight: 0.5 },
        ],
      }),
    });
    expect(res.status).toBe(200);
  });
});

describe("PATCH /experiments/:id — DRAFT PAYWALL variant enforcement", () => {
  it("400s when PATCH swaps in a variant referencing a foreign paywall", async () => {
    const { userId, cookie } = await createUserAndSession("patch-foreign");
    const project = await seedProject("patch-foreign");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "patch-foreign");
    const paywallA = await seedPaywall(project.id, offering.id, "patch-foreign-a");
    const paywallB = await seedPaywall(project.id, offering.id, "patch-foreign-b");
    const audience = await seedAudience(project.id, "patch-foreign");

    const otherProject = await seedProject("patch-foreign-other");
    trackProject(otherProject.id);
    const otherOffering = await seedOffering(otherProject.id, "patch-foreign-other");
    const otherPaywall = await seedPaywall(otherProject.id, otherOffering.id, "patch-foreign-other");

    const app = buildApp();
    const createRes = await app.request("/experiments", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        projectId: project.id,
        name: "Paywall Experiment Patch",
        type: "PAYWALL",
        audienceId: audience.id,
        variants: [
          { id: "a", name: "A", value: { paywallId: paywallA.id }, weight: 0.5 },
          { id: "b", name: "B", value: { paywallId: paywallB.id }, weight: 0.5 },
        ],
      }),
    });
    expect(createRes.status).toBe(200);
    const { data: createData } = (await createRes.json()) as { data: { experiment: { id: string } } };
    const experimentId = createData.experiment.id;

    const patchRes = await app.request(`/experiments/${experimentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        variants: [
          { id: "a", name: "A", value: { paywallId: otherPaywall.id }, weight: 0.5 },
          { id: "b", name: "B", value: { paywallId: paywallB.id }, weight: 0.5 },
        ],
      }),
    });
    expect(patchRes.status).toBe(400);
  });
});
