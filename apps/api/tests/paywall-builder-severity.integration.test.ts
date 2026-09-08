// =============================================================
// Paywall builder severity gate — the C1 regression + the publish
// gate that must remain in place around it.
//
// Drives the REAL routes (not validateBuilderConfig directly): a
// blank default-locale value on a used key is exactly the state the
// builder leaves a freshly-added text node in (every locale stubbed
// as ""), and asserting against the validator function alone is what
// let the original bug — every autosave 400ing until copy is written
// — ship in the first place. Mirrors the bootstrap in
// dashboard-paywalls.integration.test.ts: real Postgres via
// testcontainers, real Better Auth session, real Hono app mounting
// the production route tree.
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
  const email = `pwseverity_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!pwseverity";
  const name = `Paywall Severity User ${suffix}`;

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
  const id = `prj_pwseverity_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Paywall Severity Project ${RUN_ID}${suffix}`,
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

/** A single text node whose default-locale value is blank — exactly what the
 * builder stubs a freshly-added text node's localization to in every
 * locale. Deliberately carries no packageList/purchaseButton so no
 * MISSING_PURCHASE_BUTTON issue is in play; the only issue this config can
 * produce is the one under test. */
function configWithBlankTitle() {
  return {
    formatVersion: 2,
    defaultLocale: "en",
    localizations: { en: { title: "" } },
    root: {
      type: "stack",
      id: "root",
      axis: "v",
      children: [{ type: "text", id: "t1", key: "title", role: "title" }],
    },
  };
}

/** Two nodes sharing one id — DUPLICATE_NODE_ID, a save-blocking (and thus
 * still publish-blocking) code untouched by this fix. */
function configWithDuplicateNodeId() {
  return {
    formatVersion: 2,
    defaultLocale: "en",
    localizations: { en: { title: "Go Pro" } },
    root: {
      type: "stack",
      id: "root",
      axis: "v",
      children: [
        { type: "text", id: "dup", key: "title", role: "title" },
        { type: "spacer", id: "dup", size: 4 },
      ],
    },
  };
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

describe("paywall builder severity gate — save vs publish", () => {
  it("C1 regression: a blank default-locale value on a used key still 200s the PATCH save, and round-trips intact", async () => {
    const { userId, cookie } = await createUserAndSession("c1");
    const project = await seedProject("c1");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "c1");

    const app = buildApp();
    const paywallId = await createPaywall(app, project.id, cookie, offering.id, "c1-paywall");

    const patchRes = await app.request(`/projects/${project.id}/paywalls/${paywallId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ draftRevision: 0, builderConfig: configWithBlankTitle() }),
    });
    expect(patchRes.status).toBe(200);
    const { data } = (await patchRes.json()) as { data: { paywall: Record<string, unknown> } };
    expect(data.paywall.builderConfig).toEqual(configWithBlankTitle());

    // Round-trips on read too, not just on the PATCH response.
    const getRes = await app.request(`/projects/${project.id}/paywalls/${paywallId}`, {
      method: "GET",
      headers: { cookie },
    });
    const { data: getData } = (await getRes.json()) as { data: { paywall: Record<string, unknown> } };
    expect(getData.paywall.builderConfig).toEqual(configWithBlankTitle());
  });

  it("publish is still gated: the same blank-value paywall 400s on publish with EMPTY_LOC_VALUE", async () => {
    const { userId, cookie } = await createUserAndSession("publish-gated");
    const project = await seedProject("publish-gated");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "publish-gated");

    const app = buildApp();
    const paywallId = await createPaywall(
      app,
      project.id,
      cookie,
      offering.id,
      "publish-gated-paywall",
    );

    const patchRes = await app.request(`/projects/${project.id}/paywalls/${paywallId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ draftRevision: 0, builderConfig: configWithBlankTitle() }),
    });
    expect(patchRes.status).toBe(200);

    const publishRes = await app.request(`/projects/${project.id}/paywalls/${paywallId}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      // Publish states the revision the caller reviewed (see the route's
      // `publishBodySchema`) — read the row's current one, so what is
      // under test here stays the publish gate, not the CAS.
      body: JSON.stringify({
        draftRevision:
          (await drizzle.paywallRepo.findPaywallById(getDb(), project.id, paywallId))
            ?.draftRevision ?? 0,
      }),
    });
    expect(publishRes.status).toBe(400);
    const { error } = (await publishRes.json()) as { error: { message: string } };
    const parsed = JSON.parse(error.message) as {
      code: string;
      issues: Array<{ code: string }>;
    };
    expect(parsed.code).toBe("PAYWALL_NOT_PUBLISHABLE");
    expect(parsed.issues.some((i) => i.code === "EMPTY_LOC_VALUE")).toBe(true);
  });

  it("the publish gate was not weakened: a save-blocking DUPLICATE_NODE_ID config still 400s the publish route", async () => {
    const { userId, cookie } = await createUserAndSession("dup-publish");
    const project = await seedProject("dup-publish");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "dup-publish");

    const app = buildApp();
    const paywallId = await createPaywall(
      app,
      project.id,
      cookie,
      offering.id,
      "dup-publish-paywall",
    );

    // First save a valid config so the paywall has SOMETHING to publish from
    // (publish reads paywalls.builderConfig — a save that later became
    // invalid is a different scenario than one that was never saved).
    const validPatchRes = await app.request(`/projects/${project.id}/paywalls/${paywallId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        draftRevision: 0,
        builderConfig: {
          formatVersion: 2,
          defaultLocale: "en",
          localizations: { en: { title: "Go Pro" } },
          root: {
            type: "stack",
            id: "root",
            axis: "v",
            children: [{ type: "text", id: "t1", key: "title", role: "title" }],
          },
        },
      }),
    });
    expect(validPatchRes.status).toBe(200);

    // A config carrying a save-blocking code must ALSO be rejected by PATCH
    // (isBlockingIssue) — confirming this doesn't silently persist either.
    const dupPatchRes = await app.request(`/projects/${project.id}/paywalls/${paywallId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ draftRevision: 1, builderConfig: configWithDuplicateNodeId() }),
    });
    expect(dupPatchRes.status).toBe(400);

    // Publish must reject the paywall's persisted (valid) draft cleanly —
    // this test's real assertion is that DUPLICATE_NODE_ID, if it ever DID
    // reach the persisted draft, blocks publish too. Simulate that by
    // publishing straight after a raw DB write of the bad config, bypassing
    // the PATCH gate entirely, so the publish route's own re-validation is
    // what's under test — not PATCH's.
    await drizzle.paywallRepo.updatePaywall(getDb(), project.id, paywallId, {
      builderConfig: configWithDuplicateNodeId(),
    });

    const publishRes = await app.request(`/projects/${project.id}/paywalls/${paywallId}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      // Publish states the revision the caller reviewed (see the route's
      // `publishBodySchema`) — read the row's current one, so what is
      // under test here stays the publish gate, not the CAS.
      body: JSON.stringify({
        draftRevision:
          (await drizzle.paywallRepo.findPaywallById(getDb(), project.id, paywallId))
            ?.draftRevision ?? 0,
      }),
    });
    expect(publishRes.status).toBe(400);
    const { error } = (await publishRes.json()) as { error: { message: string } };
    const parsed = JSON.parse(error.message) as {
      code: string;
      issues: Array<{ code: string }>;
    };
    expect(parsed.code).toBe("PAYWALL_NOT_PUBLISHABLE");
    expect(parsed.issues.some((i) => i.code === "DUPLICATE_NODE_ID")).toBe(true);
  });
});
