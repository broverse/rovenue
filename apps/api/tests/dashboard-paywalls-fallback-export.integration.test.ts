// =============================================================
// Task 8 (paywall-phase-d): GET /dashboard/projects/:projectId/
// paywalls/fallback-export — spec D1 bundled fallback file.
//
// Boots two minimal Hono apps against the real dev Postgres: the
// dashboard paywalls route (real Better Auth session, mirroring
// dashboard-placements.integration.test.ts) and the SDK-facing v1
// placements route (real public API key, mirroring
// placements-events.integration.test.ts). The core assertion is
// PARITY: each exported placement entry must deep-equal the `data`
// object a live, anonymous `GET /v1/placements/:identifier` call
// returns for that same identifier — both paths now share
// resolvePlacement (apps/api/src/lib/placement-resolution.ts).
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, projects, drizzle } from "@rovenue/db";
import { auth } from "../src/lib/auth";
import { apiKeyAuth } from "../src/middleware/api-key-auth";
import { errorHandler } from "../src/middleware/error";
import { paywallsDashboardRoute } from "../src/routes/dashboard/paywalls";
import { placementsRoute } from "../src/routes/v1/placements";

const RUN_ID = Date.now();

function buildDashboardApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app.route("/projects/:projectId/paywalls", paywallsDashboardRoute);
}

function buildV1App() {
  const app = new Hono();
  app.use("*", apiKeyAuth("any"));
  app.onError(errorHandler);
  return app.route("/v1/placements", placementsRoute);
}

async function createUserAndSession(
  suffix: string,
): Promise<{ userId: string; cookie: string }> {
  const email = `fallbackexport_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!fallbackexport";
  const name = `Fallback Export User ${suffix}`;

  const signUp = await auth.api.signUpEmail({
    body: { email, password, name },
  });
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
  const id = `prj_fbexport_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Fallback Export Project ${RUN_ID}${suffix}`,
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
  role: "OWNER" | "ADMIN" | "CUSTOMER_SUPPORT";
}) {
  await getDb().insert(drizzle.schema.projectMembers).values({
    projectId,
    userId,
    role,
  });
}

async function seedPublicApiKey(projectId: string) {
  const db = getDb();
  const keyPublic = `rov_pub_fbexport_${RUN_ID}_${Math.random().toString(36).slice(2)}`;
  await db.insert(drizzle.schema.apiKeys).values({
    projectId,
    label: "fallback-export-test",
    keyPublic,
    keySecretHash: "n/a",
    environment: "PRODUCTION",
  });
  return keyPublic;
}

async function seedOffering(projectId: string, suffix = "") {
  const db = getDb();
  const [row] = await db
    .insert(drizzle.schema.offerings)
    .values({ projectId, identifier: `offering_${RUN_ID}${suffix}`, packages: [] })
    .returning();
  return { id: row!.id };
}

// Seeds a paywall AND publishes it (paywall_versions row + publishedVersionId)
// so it actually resolves through resolvePlacement — after the draft/publish
// split, an unpublished paywall resolves to null just like an inactive one,
// so a paywall-parity test needs a real published snapshot to compare
// against, not a vacuous null-equals-null pass.
async function seedPaywall(projectId: string, offeringId: string, suffix = "") {
  const db = getDb();
  const remoteConfig = { defaultLocale: "en", locales: { en: { title: `Title ${suffix}` } } };
  const [row] = await db
    .insert(drizzle.schema.paywalls)
    .values({
      projectId,
      identifier: `paywall_${RUN_ID}${suffix}`,
      name: `Paywall ${suffix}`,
      offeringId,
      remoteConfig,
    })
    .returning();
  const version = await drizzle.paywallVersionRepo.insert(db, {
    paywallId: row!.id,
    versionNo: 1,
    builderConfig: null,
    remoteConfig,
    offeringId,
    configFormatVersion: 1,
  });
  await drizzle.paywallRepo.setPublishedVersion(db, projectId, row!.id, version.id);
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

async function seedExperiment(
  projectId: string,
  audienceId: string,
  variantPaywallIds: [string, string],
  suffix = "",
) {
  const db = getDb();
  const [row] = await db
    .insert(drizzle.schema.experiments)
    .values({
      projectId,
      name: `Experiment ${suffix}`,
      type: "PAYWALL",
      key: `exp_${RUN_ID}${suffix}`,
      audienceId,
      status: "RUNNING",
      variants: [
        { id: "a", name: "A", value: { paywallId: variantPaywallIds[0] }, weight: 0.5 },
        { id: "b", name: "B", value: { paywallId: variantPaywallIds[1] }, weight: 0.5 },
      ],
    })
    .returning();
  return { id: row!.id };
}

async function seedPlacement(
  projectId: string,
  identifier: string,
  rows: unknown,
  isActive = true,
) {
  const db = getDb();
  const [row] = await db
    .insert(drizzle.schema.placements)
    .values({
      projectId,
      identifier,
      name: identifier,
      rows,
      isActive,
    })
    .returning();
  return { id: row!.id, identifier: row!.identifier };
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

describe("GET /dashboard/projects/:projectId/paywalls/fallback-export", () => {
  it("exports every ACTIVE placement, parity-matching a live anonymous GET /v1/placements/:identifier call each", async () => {
    const { userId, cookie } = await createUserAndSession("parity");
    const project = await seedProject("parity");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "CUSTOMER_SUPPORT" });
    const publicKey = await seedPublicApiKey(project.id);

    const offering = await seedOffering(project.id, "parity");
    const directPaywall = await seedPaywall(project.id, offering.id, "parity-direct");
    const variantPaywallA = await seedPaywall(project.id, offering.id, "parity-var-a");
    const variantPaywallB = await seedPaywall(project.id, offering.id, "parity-var-b");
    const audience = await seedAudience(project.id, "parity");
    const experiment = await seedExperiment(
      project.id,
      audience.id,
      [variantPaywallA.id, variantPaywallB.id],
      "parity",
    );

    const directPlacement = await seedPlacement(
      project.id,
      `direct-placement-${RUN_ID}`,
      [{ audienceId: null, target: { type: "paywall", paywallId: directPaywall.id } }],
    );
    const experimentPlacement = await seedPlacement(
      project.id,
      `experiment-placement-${RUN_ID}`,
      [{ audienceId: null, target: { type: "experiment", experimentId: experiment.id } }],
    );
    // Inactive placement — must be EXCLUDED from the export.
    const inactivePlacement = await seedPlacement(
      project.id,
      `inactive-placement-${RUN_ID}`,
      [{ audienceId: null, target: { type: "paywall", paywallId: directPaywall.id } }],
      false,
    );

    const dashboardApp = buildDashboardApp();
    const exportRes = await dashboardApp.request(
      `/projects/${project.id}/paywalls/fallback-export`,
      { headers: { cookie } },
    );
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers.get("content-disposition")).toBe(
      'attachment; filename="rovenue-fallback.json"',
    );
    const exportBody = (await exportRes.json()) as {
      formatVersion: number;
      generatedAt: number;
      projectId: string;
      placements: Record<string, unknown>;
    };

    expect(exportBody.formatVersion).toBe(1);
    expect(typeof exportBody.generatedAt).toBe("number");
    expect(exportBody.projectId).toBe(project.id);
    expect(Object.keys(exportBody.placements).sort()).toEqual(
      [directPlacement.identifier, experimentPlacement.identifier].sort(),
    );
    expect(exportBody.placements[inactivePlacement.identifier]).toBeUndefined();

    // Guard against a vacuous null-equals-null parity pass: the direct
    // placement's paywall must actually resolve to the published snapshot,
    // not just match the (also-null) live response.
    const directEntry = exportBody.placements[directPlacement.identifier] as {
      paywall: { remoteConfig: { data: { title: string } } } | null;
    };
    expect(directEntry.paywall).not.toBeNull();
    expect(directEntry.paywall!.remoteConfig.data.title).toBe("Title parity-direct");

    const v1App = buildV1App();
    for (const identifier of [directPlacement.identifier, experimentPlacement.identifier]) {
      const liveRes = await v1App.request(`/v1/placements/${identifier}`, {
        headers: { authorization: `Bearer ${publicKey}` },
      });
      expect(liveRes.status).toBe(200);
      const liveBody = (await liveRes.json()) as { data: unknown };
      expect(exportBody.placements[identifier]).toEqual(liveBody.data);
    }
  });
});
