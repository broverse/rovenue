// =============================================================
// Paywall save gate — proves the retier at both gates, driving the
// REAL routes (not validateBuilderConfig directly): asserting against
// the validator function alone is what let the original bug — every
// autosave 400ing on an ordinary in-progress authoring state — ship
// in the first place. Mirrors the bootstrap in
// paywall-builder-severity.integration.test.ts: real Postgres via
// testcontainers, real Better Auth session, real Hono app mounting
// the production route tree.
//
// One case per reachable authoring state that used to 400 the PATCH.
// Each asserts BOTH halves — the save succeeds AND the publish still
// rejects — because a config that saves but also publishes would be
// a worse bug than the one being fixed. The final case is the
// negative: a config that must still 400 the PATCH, proving the
// retier did not empty the save gate entirely.
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, projects, drizzle } from "@rovenue/db";
import { auth } from "../src/lib/auth";
import { errorHandler } from "../src/middleware/error";
import { paywallsDashboardRoute } from "../src/routes/dashboard/paywalls";

const RUN_ID = Date.now();

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app.route("/projects/:projectId/paywalls", paywallsDashboardRoute);
}

async function createUserAndSession(
  suffix: string,
): Promise<{ userId: string; cookie: string }> {
  const email = `pwsavegate_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!pwsavegate";
  const name = `Paywall Save Gate User ${suffix}`;

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
  const id = `prj_pwsavegate_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Paywall Save Gate Project ${RUN_ID}${suffix}`,
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

async function seedOffering(projectId: string, suffix = "") {
  const db = getDb();
  const [row] = await db
    .insert(drizzle.schema.offerings)
    .values({
      projectId,
      identifier: `offering_${RUN_ID}${suffix}`,
      packages: [],
    })
    .returning();
  return { id: row!.id };
}

const validRemoteConfig = {
  defaultLocale: "en",
  locales: { en: { title: "Go Pro" } },
};

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

async function createPaywall(
  app: ReturnType<typeof buildApp>,
  projectId: string,
  cookie: string,
  offeringId: string,
  identifier: string,
) {
  const res = await app.request(`/projects/${projectId}/paywalls`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      identifier,
      name: identifier,
      offeringId,
      remoteConfig: validRemoteConfig,
    }),
  });
  const { data } = (await res.json()) as { data: { paywall: { id: string } } };
  return data.paywall.id;
}

function configWith(children: unknown[]) {
  return {
    formatVersion: 2,
    defaultLocale: "en",
    localizations: { en: { k: "Buy" } },
    root: { type: "stack", id: "root", axis: "v", children },
  };
}

async function patchConfig(
  app: ReturnType<typeof buildApp>,
  projectId: string,
  paywallId: string,
  cookie: string,
  builderConfig: unknown,
) {
  return app.request(`/projects/${projectId}/paywalls/${paywallId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    // Every call site patches a paywall right after `createPaywall`, with
    // no earlier PATCH — draftRevision is still the column default (0).
    body: JSON.stringify({ draftRevision: 0, builderConfig }),
  });
}

async function publish(
  app: ReturnType<typeof buildApp>,
  projectId: string,
  paywallId: string,
  cookie: string,
) {
  // Publish states the revision the caller reviewed (see the route's
  // `publishBodySchema`); read the row's current one so these tests
  // exercise the publish GATE, not the compare-and-swap.
  const row = await drizzle.paywallRepo.findPaywallById(getDb(), projectId, paywallId);
  return app.request(`/projects/${projectId}/paywalls/${paywallId}/publish`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ draftRevision: row?.draftRevision ?? 0 }),
  });
}

async function expectPublishRejectedWith(
  res: Response,
  expectedCode: string,
) {
  expect(res.status).toBe(400);
  const { error } = (await res.json()) as { error: { message: string } };
  const parsed = JSON.parse(error.message) as {
    code: string;
    issues: Array<{ code: string }>;
  };
  expect(parsed.code).toBe("PAYWALL_NOT_PUBLISHABLE");
  expect(parsed.issues.some((i) => i.code === expectedCode)).toBe(true);
}

describe("paywall save gate — an incomplete draft saves; only publish is gated on completeness", () => {
  it("a package list with no purchase button saves, but does not publish", async () => {
    const { userId, cookie } = await createUserAndSession("missing-purchase");
    const project = await seedProject("missing-purchase");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "missing-purchase");

    const app = buildApp();
    const paywallId = await createPaywall(
      app,
      project.id,
      cookie,
      offering.id,
      "missing-purchase-paywall",
    );

    const builderConfig = configWith([
      { type: "packageList", id: "pl", packageIds: [], cellLayout: "row" },
    ]);

    const patchRes = await patchConfig(app, project.id, paywallId, cookie, builderConfig);
    if (patchRes.status !== 200) {
      const body = await patchRes.text();
      throw new Error(`unexpected PATCH ${patchRes.status}: ${body}`);
    }
    expect(patchRes.status).toBe(200);

    const publishRes = await publish(app, project.id, paywallId, cookie);
    await expectPublishRejectedWith(publishRes, "MISSING_PURCHASE_BUTTON");
  });

  it("a packageId outside the offering saves, but does not publish", async () => {
    const { userId, cookie } = await createUserAndSession("foreign-package");
    const project = await seedProject("foreign-package");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "foreign-package");

    const app = buildApp();
    const paywallId = await createPaywall(
      app,
      project.id,
      cookie,
      offering.id,
      "foreign-package-paywall",
    );

    const builderConfig = configWith([
      { type: "packageList", id: "pl", packageIds: ["pkg_not_in_offering"], cellLayout: "row" },
      { type: "purchaseButton", id: "pb", labelKey: "k" },
    ]);

    const patchRes = await patchConfig(app, project.id, paywallId, cookie, builderConfig);
    if (patchRes.status !== 200) {
      const body = await patchRes.text();
      throw new Error(`unexpected PATCH ${patchRes.status}: ${body}`);
    }
    expect(patchRes.status).toBe(200);

    const publishRes = await publish(app, project.id, paywallId, cookie);
    await expectPublishRejectedWith(publishRes, "FOREIGN_PACKAGE_ID");
  });

  it("a default locale pointing at an empty table saves, but does not publish", async () => {
    const { userId, cookie } = await createUserAndSession("unknown-loc-key");
    const project = await seedProject("unknown-loc-key");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "unknown-loc-key");

    const app = buildApp();
    const paywallId = await createPaywall(
      app,
      project.id,
      cookie,
      offering.id,
      "unknown-loc-key-paywall",
    );

    const builderConfig = {
      formatVersion: 2,
      defaultLocale: "de",
      localizations: { en: { k: "Buy" }, de: {} },
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [{ type: "purchaseButton", id: "pb", labelKey: "k" }],
      },
    };

    const patchRes = await patchConfig(app, project.id, paywallId, cookie, builderConfig);
    if (patchRes.status !== 200) {
      const body = await patchRes.text();
      throw new Error(`unexpected PATCH ${patchRes.status}: ${body}`);
    }
    expect(patchRes.status).toBe(200);

    const publishRes = await publish(app, project.id, paywallId, cookie);
    await expectPublishRejectedWith(publishRes, "UNKNOWN_LOC_KEY");
  });

  it("a packageList nested inside a cellTemplate saves, but does not publish", async () => {
    const { userId, cookie } = await createUserAndSession("cell-template-bad-node");
    const project = await seedProject("cell-template-bad-node");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "cell-template-bad-node");

    const app = buildApp();
    const paywallId = await createPaywall(
      app,
      project.id,
      cookie,
      offering.id,
      "cell-template-bad-node-paywall",
    );

    const builderConfig = configWith([
      {
        type: "packageList",
        id: "outer",
        packageIds: [],
        cellLayout: "row",
        cellTemplate: { type: "packageList", id: "inner", packageIds: [], cellLayout: "row" },
      },
      { type: "purchaseButton", id: "pb", labelKey: "k" },
    ]);

    const patchRes = await patchConfig(app, project.id, paywallId, cookie, builderConfig);
    if (patchRes.status !== 200) {
      const body = await patchRes.text();
      throw new Error(`unexpected PATCH ${patchRes.status}: ${body}`);
    }
    expect(patchRes.status).toBe(200);

    const publishRes = await publish(app, project.id, paywallId, cookie);
    await expectPublishRejectedWith(publishRes, "CELL_TEMPLATE_BAD_NODE");
  });

  it("the negative: two nodes sharing one id still 400s the PATCH — the save gate was not emptied", async () => {
    const { userId, cookie } = await createUserAndSession("duplicate-node-id");
    const project = await seedProject("duplicate-node-id");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "duplicate-node-id");

    const app = buildApp();
    const paywallId = await createPaywall(
      app,
      project.id,
      cookie,
      offering.id,
      "duplicate-node-id-paywall",
    );

    const builderConfig = configWith([
      { type: "spacer", id: "dup", size: 4 },
      { type: "spacer", id: "dup", size: 8 },
    ]);

    const patchRes = await patchConfig(app, project.id, paywallId, cookie, builderConfig);
    expect(patchRes.status).toBe(400);
  });
});
