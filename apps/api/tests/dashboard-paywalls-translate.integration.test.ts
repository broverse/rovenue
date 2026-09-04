// =============================================================
// POST /projects/:projectId/paywalls/:id/translate
//
// Same harness as dashboard-paywalls.integration.test.ts: a minimal Hono
// app on the production path, real Postgres, a real Better Auth session
// cookie so requireDashboardAuth runs unmocked.
//
// The MODEL is stubbed at the service seam. What is tested here is the
// route's contract, not translation quality: who may call it, what it
// rejects, and — the one that matters most — that it persists NOTHING.
// A server-side builderConfig write would be clobbered by the builder's
// next autosave tick, so "writes nothing" is a correctness property of
// this endpoint, not an implementation detail.
// =============================================================

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { getDb, projects, drizzle } from "@rovenue/db";
import { auth } from "../src/lib/auth";
import { errorHandler } from "../src/middleware/error";

const translateEntriesMock = vi.hoisted(() => vi.fn());
vi.mock("../src/services/paywall-ai/translate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/paywall-ai/translate")>();
  return {
    ...actual,
    translateEntries: (...args: unknown[]) => translateEntriesMock(...args),
  };
});

vi.mock("../src/lib/edge-cache", () => ({
  purgeProjectCatalogCache: vi.fn(),
}));

const { paywallsDashboardRoute } = await import("../src/routes/dashboard/paywalls");
const { TranslationInvalidError } = await import("../src/services/paywall-ai/translate");
const { RoviConfigError } = await import("../src/services/copilot/providers");

const RUN_ID = Date.now();

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app.route("/projects/:projectId/paywalls", paywallsDashboardRoute);
}

async function createUserAndSession(suffix: string) {
  const email = `pwtranslate_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!pwtranslate";
  const signUp = await auth.api.signUpEmail({
    body: { email, password, name: `Translate User ${suffix}` },
  });
  if (!signUp?.user?.id) throw new Error("signUp failed");
  const signIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const rawCookie = signIn.headers.get("set-cookie") ?? "";
  const cookie = rawCookie.split(",").map((s) => s.trim().split(";")[0]).join("; ");
  return { userId: signUp.user.id, cookie };
}

async function seedProjectWithPaywall(suffix: string) {
  const db = getDb();
  const projectId = `prj_pwtr_${RUN_ID}${suffix}`;
  await db.insert(projects).values({ id: projectId, name: `Translate Project ${suffix}` });

  const [offering] = await db
    .insert(drizzle.schema.offerings)
    .values({
      projectId,
      identifier: `offering_tr_${RUN_ID}${suffix}`,
      packages: [],
    })
    .returning();

  const builderConfig = {
    formatVersion: 2,
    defaultLocale: "en",
    localizations: { en: { title_1: "Go Pro" } },
    root: {
      type: "stack",
      id: "root",
      axis: "v",
      children: [{ type: "text", id: "t1", key: "title_1", role: "title" }],
    },
  };

  const [paywall] = await db
    .insert(drizzle.schema.paywalls)
    .values({
      projectId,
      offeringId: offering!.id,
      identifier: `pw_tr_${RUN_ID}${suffix}`,
      name: "Translate Paywall",
      remoteConfig: { defaultLocale: "en", locales: { en: { title_1: "Go Pro" } } },
      builderConfig,
    })
    .returning();

  return { projectId, paywallId: paywall!.id, builderConfig };
}

async function seedMember(projectId: string, userId: string) {
  await getDb().insert(drizzle.schema.projectMembers).values({
    projectId,
    userId,
    role: "OWNER",
  });
}

const BODY = {
  sourceLocale: "en",
  targetLocale: "es",
  entries: { title_1: "Go Pro" },
};

function post(app: ReturnType<typeof buildApp>, projectId: string, id: string, cookie: string, body: unknown) {
  return app.request(`/projects/${projectId}/paywalls/${id}/translate`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

afterAll(async () => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  translateEntriesMock.mockReset().mockResolvedValue({
    entries: { title_1: "Hazte Pro" },
    rejected: [],
  });
});

describe("POST /paywalls/:id/translate", () => {
  it("returns the service's entries and rejected list", async () => {
    const app = buildApp();
    const { projectId, paywallId } = await seedProjectWithPaywall("_ok");
    const { userId, cookie } = await createUserAndSession("ok");
    await seedMember(projectId, userId);

    translateEntriesMock.mockResolvedValue({
      entries: { title_1: "Hazte Pro" },
      rejected: ["subtitle_1"],
    });

    const res = await post(app, projectId, paywallId, cookie, BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { entries: { title_1: "Hazte Pro" }, rejected: ["subtitle_1"] },
    });
  });

  it("PERSISTS NOTHING — the paywall row is byte-identical afterwards", async () => {
    const app = buildApp();
    const { projectId, paywallId } = await seedProjectWithPaywall("_nowrite");
    const { userId, cookie } = await createUserAndSession("nowrite");
    await seedMember(projectId, userId);

    const before = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, paywallId);
    const res = await post(app, projectId, paywallId, cookie, BODY);
    expect(res.status).toBe(200);
    const after = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, paywallId);

    // The translations must reach the config only through the dashboard's
    // own setLocalizations op; a write here loses to the next autosave.
    expect(after!.builderConfig).toEqual(before!.builderConfig);
    expect(after!.remoteConfig).toEqual(before!.remoteConfig);
    expect(after!.updatedAt).toEqual(before!.updatedAt);
  });

  it("passes the BODY's strings to the service, not the row's", async () => {
    const app = buildApp();
    const { projectId, paywallId } = await seedProjectWithPaywall("_body");
    const { userId, cookie } = await createUserAndSession("body");
    await seedMember(projectId, userId);

    // The row says "Go Pro"; the client's draft says something else because
    // autosave has not caught up. The service must see the client's.
    await post(app, projectId, paywallId, cookie, {
      ...BODY,
      entries: { title_1: "Go Pro Now" },
    });

    expect(translateEntriesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        sourceLocale: "en",
        targetLocale: "es",
        entries: { title_1: "Go Pro Now" },
      }),
    );
  });

  it("404s for a paywall id that is not in this project", async () => {
    const app = buildApp();
    const { projectId } = await seedProjectWithPaywall("_404");
    const { userId, cookie } = await createUserAndSession("404");
    await seedMember(projectId, userId);

    const res = await post(app, projectId, "pw_does_not_exist", cookie, BODY);
    expect(res.status).toBe(404);
    expect(translateEntriesMock).not.toHaveBeenCalled();
  });

  it("400s when source and target are the same locale", async () => {
    const app = buildApp();
    const { projectId, paywallId } = await seedProjectWithPaywall("_same");
    const { userId, cookie } = await createUserAndSession("same");
    await seedMember(projectId, userId);

    const res = await post(app, projectId, paywallId, cookie, {
      ...BODY,
      targetLocale: "en",
    });
    expect(res.status).toBe(400);
    expect(translateEntriesMock).not.toHaveBeenCalled();
  });

  it("400s for an empty entries object", async () => {
    const app = buildApp();
    const { projectId, paywallId } = await seedProjectWithPaywall("_empty");
    const { userId, cookie } = await createUserAndSession("empty");
    await seedMember(projectId, userId);

    const res = await post(app, projectId, paywallId, cookie, { ...BODY, entries: {} });
    expect(res.status).toBe(400);
    expect(translateEntriesMock).not.toHaveBeenCalled();
  });

  it("401s without a session", async () => {
    const app = buildApp();
    const { projectId, paywallId } = await seedProjectWithPaywall("_noauth");
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywallId}/translate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(BODY),
      },
    );
    expect(res.status).toBe(401);
    expect(translateEntriesMock).not.toHaveBeenCalled();
  });

  it("403s for a user who is not a member of the project", async () => {
    const app = buildApp();
    const { projectId, paywallId } = await seedProjectWithPaywall("_outsider");
    const { cookie } = await createUserAndSession("outsider");

    const res = await post(app, projectId, paywallId, cookie, BODY);
    expect(res.status).toBe(403);
    expect(translateEntriesMock).not.toHaveBeenCalled();
  });

  it("maps RoviConfigError to 412 ROVI_NOT_CONFIGURED", async () => {
    const app = buildApp();
    const { projectId, paywallId } = await seedProjectWithPaywall("_norovi");
    const { userId, cookie } = await createUserAndSession("norovi");
    await seedMember(projectId, userId);

    translateEntriesMock.mockRejectedValue(new RoviConfigError("no provider"));
    const res = await post(app, projectId, paywallId, cookie, BODY);
    expect(res.status).toBe(412);
    expect((await res.json()).error.code).toBe("ROVI_NOT_CONFIGURED");
  });

  it("maps TranslationInvalidError to 422 TRANSLATION_INVALID", async () => {
    const app = buildApp();
    const { projectId, paywallId } = await seedProjectWithPaywall("_invalid");
    const { userId, cookie } = await createUserAndSession("invalid");
    await seedMember(projectId, userId);

    translateEntriesMock.mockRejectedValue(new TranslationInvalidError("nothing to translate"));
    const res = await post(app, projectId, paywallId, cookie, BODY);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("TRANSLATION_INVALID");
  });
});
