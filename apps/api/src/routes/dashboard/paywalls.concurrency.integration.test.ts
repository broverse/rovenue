// =============================================================
// Draft write concurrency — PATCH /projects/:projectId/paywalls/:id
//
// Same harness as dashboard-paywalls.integration.test.ts (apps/api/tests):
// minimal Hono app mounted on the production path, real Postgres, a real
// Better Auth session cookie so requireDashboardAuth (and the
// paywalls:write capability gate) run unmocked.
//
// `paywalls.builderConfig` is the draft and the dashboard builder's
// autosave target. Two writers — two builder tabs, or a builder tab and
// a server-side agent — can read the same row and both PATCH it. Without
// compare-and-swap on `draftRevision`, the second write silently clobbers
// the first with no signal to either caller. This file proves the CAS
// predicate actually serializes concurrent writers (not just sequential
// ones with a stale number), and that an un-migrated client omitting
// draftRevision fails closed instead of being defaulted.
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, projects, drizzle } from "@rovenue/db";
import { auth } from "../../lib/auth";
import { errorHandler } from "../../middleware/error";
import { paywallsDashboardRoute } from "./paywalls";

const CONFLICT_STATUS = 409;
const RUN_ID = Date.now();

// A schema-valid draft — the brief's inline example (`{ root: { id, type:
// "stack", children: [] } }`) omits formatVersion/defaultLocale/
// localizations, which `builderConfigSchema` requires unconditionally (see
// packages/shared/src/paywall/schema.ts); an incomplete payload 400s at the
// validation gate before ever reaching the CAS write, which would make
// both concurrent requests fail identically and prove nothing about the
// race. This is the minimal config that clears both the schema parse and
// the save-gate's blocking-issue check (an empty root has no
// MISSING_PURCHASE_BUTTON-type issue — that gate only fires at publish).
function draftConfig(rootId: string) {
  return {
    formatVersion: 2,
    defaultLocale: "en",
    localizations: { en: {} },
    root: { id: rootId, type: "stack", axis: "v", children: [] },
  };
}

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app.route("/projects/:projectId/paywalls", paywallsDashboardRoute);
}

async function createUserAndSession(
  suffix: string,
): Promise<{ userId: string; cookie: string }> {
  const email = `pwconcurrency_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!pwconcurrency";
  const name = `Paywall Concurrency User ${suffix}`;

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
  const id = `prj_pwconcurrency_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Paywall Concurrency Project ${RUN_ID}${suffix}`,
  });
  return { id };
}

// Membership role holding `paywalls:write` — ADMIN, chosen to match the
// sibling paywall route integration tests (see capabilities.ts).
async function seedMember(projectId: string, userId: string) {
  await getDb().insert(drizzle.schema.projectMembers).values({
    projectId,
    userId,
    role: "ADMIN",
  });
}

async function seedOffering(projectId: string, suffix = "") {
  const db = getDb();
  const [row] = await db
    .insert(drizzle.schema.offerings)
    .values({
      projectId,
      identifier: `offering_pwconcurrency_${RUN_ID}${suffix}`,
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

/**
 * A fresh user + project + ADMIN membership + offering + paywall, ready
 * for a draft PATCH. The returned paywall carries no builderConfig yet —
 * its `draftRevision` is the column's default (0).
 */
async function seedPaywall(suffix: string) {
  const { userId, cookie } = await createUserAndSession(suffix);
  const project = await seedProject(suffix);
  trackProject(project.id);
  await seedMember(project.id, userId);
  const offering = await seedOffering(project.id, suffix);

  const app = buildApp();
  const createRes = await app.request(`/projects/${project.id}/paywalls`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      identifier: `pwconcurrency-${suffix}`,
      name: `Paywall Concurrency ${suffix}`,
      offeringId: offering.id,
      remoteConfig: validRemoteConfig,
    }),
  });
  if (createRes.status !== 200) {
    throw new Error(`unexpected create ${createRes.status}: ${await createRes.text()}`);
  }
  const { data } = (await createRes.json()) as { data: { paywall: { id: string } } };

  return { app, cookie, projectId: project.id, paywallId: data.paywall.id };
}

describe("PATCH /projects/:projectId/paywalls/:id — draft concurrency", () => {
  it("two concurrent draft writes: exactly one wins, the loser gets 409", async () => {
    const { app, cookie, projectId, paywallId } = await seedPaywall("race");

    const read = await app.request(
      `/projects/${projectId}/paywalls/${paywallId}`,
      { headers: { cookie } },
    );
    // GET /:id answers `{ data: { paywall: <row> } }` — the whole row, so
    // draftRevision rides along without a serializer change.
    const { data } = await read.json();
    const revision: number = data.paywall.draftRevision;

    // Both writers read the SAME revision, as two builder tabs would.
    const [first, second] = await Promise.all([
      app.request(`/projects/${projectId}/paywalls/${paywallId}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ draftRevision: revision, builderConfig: draftConfig("a") }),
      }),
      app.request(`/projects/${projectId}/paywalls/${paywallId}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ draftRevision: revision, builderConfig: draftConfig("b") }),
      }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, CONFLICT_STATUS]);
  });

  it("a write without draftRevision is rejected, not defaulted", async () => {
    // An un-migrated client must fail closed rather than clobber.
    const { app, cookie, projectId, paywallId } = await seedPaywall("nomigration");
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywallId}`,
      {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ builderConfig: draftConfig("c") }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("a combined write's non-draft fields roll back when the draft CAS conflicts", async () => {
    // The PATCH schema allows builderConfig alongside name/offeringId/etc
    // in one request. If a stale draftRevision 409s the draft half, the
    // OTHER half must not have been persisted either — otherwise the
    // caller is told the whole write failed while part of it landed.
    const { app, cookie, projectId, paywallId } = await seedPaywall("atomicity");

    const read = await app.request(`/projects/${projectId}/paywalls/${paywallId}`, {
      headers: { cookie },
    });
    const { data } = await read.json();
    const staleRevision: number = data.paywall.draftRevision;
    const originalName: string = data.paywall.name;

    // Consume that revision with an unrelated write — simulates a second
    // builder tab (or a server-side agent, once Task 5 lands) winning the
    // race first.
    const consumed = await app.request(`/projects/${projectId}/paywalls/${paywallId}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ draftRevision: staleRevision, builderConfig: draftConfig("winner") }),
    });
    expect(consumed.status).toBe(200);

    // Now PATCH with the now-stale revision, bundling a name change with
    // the (doomed) draft write.
    const res = await app.request(`/projects/${projectId}/paywalls/${paywallId}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        draftRevision: staleRevision,
        name: "Should Not Persist",
        builderConfig: draftConfig("loser"),
      }),
    });
    expect(res.status).toBe(CONFLICT_STATUS);

    const after = await app.request(`/projects/${projectId}/paywalls/${paywallId}`, {
      headers: { cookie },
    });
    const { data: afterData } = await after.json();
    expect(afterData.paywall.name).toBe(originalName);
    expect(afterData.paywall.builderConfig).toEqual(draftConfig("winner"));
  });
});

describe("Server-initiated draft rewrites also move draftRevision", () => {
  it("revert bumps draftRevision, so a stale-revision PATCH 409s afterward", async () => {
    const { app, cookie, projectId, paywallId } = await seedPaywall("revert-bump");

    const firstSave = await app.request(`/projects/${projectId}/paywalls/${paywallId}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ draftRevision: 0, builderConfig: draftConfig("v1") }),
    });
    expect(firstSave.status).toBe(200);
    const publishRes = await app.request(`/projects/${projectId}/paywalls/${paywallId}/publish`, {
      method: "POST",
      headers: { cookie },
    });
    expect(publishRes.status).toBe(200);

    // The revision a builder tab would be holding right before someone
    // else reverts the draft server-side.
    const read = await app.request(`/projects/${projectId}/paywalls/${paywallId}`, {
      headers: { cookie },
    });
    const { data } = await read.json();
    const staleRevision: number = data.paywall.draftRevision;

    const revertRes = await app.request(
      `/projects/${projectId}/paywalls/${paywallId}/versions/1/revert`,
      { method: "POST", headers: { cookie } },
    );
    expect(revertRes.status).toBe(200);

    const staleWrite = await app.request(`/projects/${projectId}/paywalls/${paywallId}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ draftRevision: staleRevision, builderConfig: draftConfig("clobber") }),
    });
    expect(staleWrite.status).toBe(CONFLICT_STATUS);
  });

  it("discard-draft bumps draftRevision, so a stale-revision PATCH 409s afterward", async () => {
    const { app, cookie, projectId, paywallId } = await seedPaywall("discard-bump");

    const firstSave = await app.request(`/projects/${projectId}/paywalls/${paywallId}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ draftRevision: 0, builderConfig: draftConfig("v1") }),
    });
    expect(firstSave.status).toBe(200);
    const publishRes = await app.request(`/projects/${projectId}/paywalls/${paywallId}/publish`, {
      method: "POST",
      headers: { cookie },
    });
    expect(publishRes.status).toBe(200);

    // Dirty the draft again after publishing, so discard-draft has
    // something to discard back from.
    const editRes = await app.request(`/projects/${projectId}/paywalls/${paywallId}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ draftRevision: 1, builderConfig: draftConfig("scratch") }),
    });
    expect(editRes.status).toBe(200);

    const read = await app.request(`/projects/${projectId}/paywalls/${paywallId}`, {
      headers: { cookie },
    });
    const { data } = await read.json();
    const staleRevision: number = data.paywall.draftRevision;

    const discardRes = await app.request(
      `/projects/${projectId}/paywalls/${paywallId}/discard-draft`,
      { method: "POST", headers: { cookie } },
    );
    expect(discardRes.status).toBe(200);

    const staleWrite = await app.request(`/projects/${projectId}/paywalls/${paywallId}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ draftRevision: staleRevision, builderConfig: draftConfig("clobber") }),
    });
    expect(staleWrite.status).toBe(CONFLICT_STATUS);
  });
});
