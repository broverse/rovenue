// =============================================================
// Funnel publish validation + funnels:write capability gate
//
// Covers Task 8: `validatePageFields` (Task 6) runs at publish time
// alongside `validateFunnelGraph`, and funnel mutation routes are
// gated on the `funnels:write` capability (Task 1) instead of the
// bare DEVELOPER rank check. Harness mirrors
// offerings.integration.test.ts: bare Hono app + errorHandler, the
// route mounted on its production path, real Postgres, real Better
// Auth session cookie.
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, projects, drizzle, type MemberRole } from "@rovenue/db";
import type { Page } from "@rovenue/shared/funnel";
import { auth } from "../../lib/auth";
import { errorHandler } from "../../middleware/error";
import { funnelsRoute } from "./funnels";

const VALIDATION_STATUS = 400;
const FORBIDDEN_STATUS = 403;

const RUN_ID = Date.now();
let seedCounter = 0;
function nextSuffix(): string {
  seedCounter += 1;
  return `${RUN_ID}_${seedCounter}`;
}

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app.route("/projects/:projectId/funnels", funnelsRoute);
}

async function createUserAndSession(
  suffix: string,
): Promise<{ userId: string; cookie: string }> {
  const email = `funnelspub_${suffix}@rovenue.test`;
  const password = "Test1234!funnelspub";
  const name = `Funnels Publish User ${suffix}`;

  const signUp = await auth.api.signUpEmail({
    body: { email, password, name },
  });
  if (!signUp?.user?.id) throw new Error("signUp failed");

  const signIn = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const rawCookie = signIn.headers.get("set-cookie") ?? "";
  const cookie = rawCookie
    .split(",")
    .map((s) => s.trim().split(";")[0])
    .join("; ");

  return { userId: signUp.user.id, cookie };
}

const seededProjectIds: string[] = [];
function trackProject(id: string) {
  seededProjectIds.push(id);
  return id;
}

async function seedProject(suffix: string) {
  const db = getDb();
  const id = `prj_funnelspub_${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Funnels Publish Project ${suffix}`,
  });
  return trackProject(id);
}

async function seedMember(
  projectId: string,
  userId: string,
  role: MemberRole,
) {
  await getDb().insert(drizzle.schema.projectMembers).values({
    projectId,
    userId,
    role,
  });
}

async function seedFunnelRow(projectId: string, suffix: string, pages: unknown[]) {
  const funnel = await drizzle.funnelRepo.insert(getDb(), {
    projectId,
    slug: `funnel-${suffix}`,
    name: `Funnel ${suffix}`,
    draftPagesJson: pages as Page[],
  });
  return funnel.id;
}

// A minimal funnel that clears `validateFunnelGraph` (has a reachable
// paywall + success page) and `validatePageFields` (neither page type
// carries a required-fields entry), so publish stops only at the
// `chargesEnabled` Stripe check.
const PUBLISHABLE_PAGES: unknown[] = [
  { id: "pw", type: "paywall", default_next: "done" },
  { id: "done", type: "success" },
];

async function seedFunnelWithPages(pages: unknown[]) {
  const suffix = nextSuffix();
  const { userId, cookie } = await createUserAndSession(suffix);
  const projectId = await seedProject(suffix);
  await seedMember(projectId, userId, "ADMIN");
  const funnelId = await seedFunnelRow(projectId, suffix, pages);
  return { cookie, projectId, funnelId };
}

async function seedFunnel() {
  return seedFunnelWithPages([]);
}

async function seedPublishableFunnelWithRole(role: MemberRole) {
  const suffix = nextSuffix();
  const { userId, cookie } = await createUserAndSession(`${suffix}_${role}`);
  const projectId = await seedProject(`${suffix}_${role}`);
  await seedMember(projectId, userId, role);
  const funnelId = await seedFunnelRow(
    projectId,
    `${suffix}_${role}`,
    PUBLISHABLE_PAGES,
  );
  return { cookie, projectId, funnelId };
}

afterAll(async () => {
  const db = getDb();
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

describe("POST /:funnelId/publish — per-type page field validation", () => {
  it("publish rejects a funnel whose choice page has no options", async () => {
    const { cookie, projectId, funnelId } = await seedFunnelWithPages([
      { id: "q1", type: "single_choice", title: "Pick", default_next: "pw" },
      { id: "pw", type: "paywall", default_next: "done" },
      { id: "done", type: "success" },
    ]);

    const app = buildApp();
    const res = await app.request(
      `/projects/${projectId}/funnels/${funnelId}/publish`,
      { method: "POST", headers: { cookie } },
    );

    expect(res.status).toBe(VALIDATION_STATUS);
    const body = JSON.parse((await res.json()).error.message);
    expect(body.code).toBe("FUNNEL_VALIDATION");
    expect(
      body.issues.some((i: { code: string }) => i.code === "MISSING_REQUIRED_FIELD"),
    ).toBe(true);
  });

  it("SAVING that same funnel still succeeds — save stays permissive", async () => {
    // Deliberate property, not an oversight: a work-in-progress draft
    // (human or agent) must never be blocked mid-edit. Without this test
    // someone will later "fix" save to validate too.
    const { cookie, projectId, funnelId } = await seedFunnel();

    const app = buildApp();
    const res = await app.request(
      `/projects/${projectId}/funnels/${funnelId}`,
      {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          draft_pages_json: [{ id: "q1", type: "single_choice", title: "Pick" }],
        }),
      },
    );
    expect(res.status).toBe(200);
  });
});

describe("funnels:write capability gate", () => {
  it("GROWTH gets past the capability gate; CUSTOMER_SUPPORT does not", async () => {
    // funnels:write is a faithful restatement of today's DEVELOPER rank
    // gate, which GROWTH already satisfies by rank equality.
    //
    // Deliberately NOT asserting 200 for GROWTH. Publish checks in order:
    // capability -> schema -> graph -> Stripe `chargesEnabled`. The graph
    // validator requires at least one paywall page, and a paywall page
    // requires a charge-capable Stripe account, so a valid funnel in a
    // test project always stops at STRIPE_NOT_CONNECTED. Asserting 200
    // would conflate authorization with Stripe setup; asserting the
    // Stripe error proves precisely what is under test — GROWTH passed
    // the gate and reached the last check.
    const growth = await seedPublishableFunnelWithRole("GROWTH");
    const cs = await seedPublishableFunnelWithRole("CUSTOMER_SUPPORT");

    const app = buildApp();

    const growthRes = await app.request(
      `/projects/${growth.projectId}/funnels/${growth.funnelId}/publish`,
      { method: "POST", headers: { cookie: growth.cookie } },
    );
    expect(growthRes.status).toBe(VALIDATION_STATUS);
    expect(JSON.parse((await growthRes.json()).error.message).code).toBe(
      "STRIPE_NOT_CONNECTED",
    );

    const csRes = await app.request(
      `/projects/${cs.projectId}/funnels/${cs.funnelId}/publish`,
      { method: "POST", headers: { cookie: cs.cookie } },
    );
    expect(csRes.status).toBe(FORBIDDEN_STATUS);
  });
});
