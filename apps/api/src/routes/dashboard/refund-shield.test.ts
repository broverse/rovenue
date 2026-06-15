// =============================================================
// Dashboard: Refund Shield routes (T16-T18) — integration tests
// =============================================================
//
// Mirrors the existing dashboard *.integration.test.ts pattern:
//   - Real Postgres (docker-compose port 5433, seeded by tests/setup.ts)
//   - Better Auth email+password signup -> set-cookie -> request()
//   - Unique RUN_ID suffixes so re-runs never collide
//
// Covers all 5 endpoints introduced by T16-T18:
//   GET  /settings, PUT  /settings
//   GET  /responses, GET /responses/:rid
//   GET  /metrics

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import {
  getDb,
  projects,
  subscribers,
  products,
  purchases,
  drizzle,
} from "@rovenue/db";
import { auth } from "../../lib/auth";
import { refundShieldRoute } from "./refund-shield";

const RUN_ID = Date.now();
const { refundShieldResponses } = drizzle.schema;

// ---------------------------------------------------------------------------
// Test app — mounts the refund-shield router exactly the way
// dashboardRoute does (path includes :projectId).
// ---------------------------------------------------------------------------

function buildApp() {
  return new Hono().route(
    "/projects/:projectId/refund-shield",
    refundShieldRoute,
  );
}

// ---------------------------------------------------------------------------
// Better Auth helpers
// ---------------------------------------------------------------------------

async function createUserAndSession(
  suffix: string,
): Promise<{ userId: string; cookie: string }> {
  const email = `refundshieldtest_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!refundshield";
  const name = `Refund Shield Test User ${suffix}`;

  const signUp = await auth.api.signUpEmail({ body: { email, password, name } });
  if (!signUp?.user) throw new Error(`signUpEmail failed for ${suffix}`);

  const signIn = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const setCookie = signIn.headers.get("set-cookie");
  if (!setCookie) throw new Error(`no set-cookie for ${suffix}`);
  const cookie = setCookie.split(";")[0] ?? "";
  return { userId: signUp.user.id, cookie };
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_rstest_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Refund Shield Test Project ${RUN_ID}${suffix}`,
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
  suffix,
}: {
  projectId: string;
  suffix: string;
}) {
  const id = `sub_rstest_${RUN_ID}_${suffix}`;
  await getDb().insert(subscribers).values({
    id,
    projectId,
    rovenueId: `app_rstest_${RUN_ID}_${suffix}`,
    appUserId: `app_rstest_${RUN_ID}_${suffix}`,
  });
  return { id };
}

async function seedProduct({
  projectId,
  suffix,
}: {
  projectId: string;
  suffix: string;
}) {
  const id = `prod_rstest_${RUN_ID}_${suffix}`;
  await getDb().insert(products).values({
    id,
    projectId,
    identifier: `com.rovenue.rstest.${RUN_ID}.${suffix}`,
    type: "SUBSCRIPTION",
    storeIds: {},
    displayName: `RS Test Product ${suffix}`,
    accessIds: [],
  });
  return { id };
}

interface SeedPurchaseInput {
  projectId: string;
  subscriberId: string;
  productId: string;
  originalTransactionId: string;
  priceAmount: string; // decimal as string
}

async function seedPurchase(input: SeedPurchaseInput) {
  await getDb()
    .insert(purchases)
    .values({
      projectId: input.projectId,
      subscriberId: input.subscriberId,
      productId: input.productId,
      store: "APP_STORE",
      storeTransactionId: input.originalTransactionId,
      originalTransactionId: input.originalTransactionId,
      status: "ACTIVE",
      isTrial: false,
      isIntroOffer: false,
      isSandbox: false,
      purchaseDate: new Date(),
      originalPurchaseDate: new Date(),
      priceAmount: input.priceAmount,
      priceCurrency: "USD",
      environment: "PRODUCTION",
    });
}

interface SeedRsrInput {
  projectId: string;
  subscriberId: string | null;
  suffix: string;
  status?:
    | "PENDING"
    | "SENT"
    | "FAILED"
    | "SKIPPED_DISABLED"
    | "SKIPPED_NOT_FOUND";
  outcome?: "REFUND_APPROVED" | "REFUND_DECLINED" | "REFUND_REVERSED" | null;
  detectedAt?: Date;
  originalTransactionId?: string;
  requestPayload?: unknown;
}

async function seedRefundShieldResponse(input: SeedRsrInput) {
  const id = `rsr_${RUN_ID}_${input.suffix}`;
  const otx = input.originalTransactionId ?? `otx_${RUN_ID}_${input.suffix}`;
  const detectedAt = input.detectedAt ?? new Date();
  const scheduledFor = new Date(detectedAt.getTime() + 60 * 60 * 1000);
  await getDb().insert(refundShieldResponses).values({
    id,
    projectId: input.projectId,
    subscriberId: input.subscriberId,
    appleNotificationUuid: `notif_${RUN_ID}_${input.suffix}`,
    appleOriginalTransactionId: otx,
    appleTransactionId: `tx_${RUN_ID}_${input.suffix}`,
    detectedAt,
    scheduledFor,
    status: input.status ?? "PENDING",
    outcome: input.outcome ?? null,
    outcomeReceivedAt: input.outcome ? new Date() : null,
    requestPayload:
      input.requestPayload ?? (input.status === "SENT" ? { sample: true } : null),
    sentAt: input.status === "SENT" ? new Date() : null,
  });
  return { id, originalTransactionId: otx };
}

// ---------------------------------------------------------------------------
// Cleanup tracking
// ---------------------------------------------------------------------------

const seededProjectIds: string[] = [];
function trackProject(id: string) {
  seededProjectIds.push(id);
  return id;
}

afterAll(async () => {
  const db = getDb();
  for (const id of seededProjectIds) {
    // Cascades cover refund_shield_responses, purchases, subscribers,
    // products, project_members via the projects.id FK chain.
    await db.delete(projects).where(eq(projects.id, id));
  }
});

// ===========================================================================
// GET /settings
// ===========================================================================

describe("GET /dashboard/projects/:projectId/refund-shield/settings", () => {
  it("returns current settings for a viewer (CUSTOMER_SUPPORT) role", async () => {
    const viewer = await createUserAndSession("get_settings_viewer");
    const project = await seedProject("_get_settings");
    trackProject(project.id);
    await seedMember({
      projectId: project.id,
      userId: viewer.userId,
      role: "CUSTOMER_SUPPORT",
    });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/refund-shield/settings`,
      { headers: { cookie: viewer.cookie } },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        settings: {
          enabled: boolean;
          responseDelayMinutes: number;
          consentAcknowledgedAt: string | null;
          consentAcknowledgedBy: string | null;
        };
      };
    };
    expect(body.data.settings.enabled).toBe(false);
    expect(body.data.settings.responseDelayMinutes).toBe(60);
    expect(body.data.settings.consentAcknowledgedAt).toBeNull();
    expect(body.data.settings.consentAcknowledgedBy).toBeNull();
  });

  it("returns 401 for unauthenticated requests", async () => {
    const app = buildApp();
    const res = await app.request(
      `/projects/some_project/refund-shield/settings`,
    );
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// PUT /settings
// ===========================================================================

describe("PUT /dashboard/projects/:projectId/refund-shield/settings", () => {
  it("owner enabling for the first time stamps consent + actor", async () => {
    const owner = await createUserAndSession("put_settings_owner");
    const project = await seedProject("_put_settings_owner");
    trackProject(project.id);
    await seedMember({
      projectId: project.id,
      userId: owner.userId,
      role: "OWNER",
    });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/refund-shield/settings`,
      {
        method: "PUT",
        headers: { cookie: owner.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          responseDelayMinutes: 90,
          consentAcknowledged: true,
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        settings: {
          enabled: boolean;
          responseDelayMinutes: number;
          consentAcknowledgedAt: string | null;
          consentAcknowledgedBy: string | null;
        };
      };
    };
    expect(body.data.settings.enabled).toBe(true);
    expect(body.data.settings.responseDelayMinutes).toBe(90);
    expect(body.data.settings.consentAcknowledgedAt).not.toBeNull();
    expect(body.data.settings.consentAcknowledgedBy).toBe(owner.userId);
  });

  it("non-owner role (ADMIN) receives 403", async () => {
    const admin = await createUserAndSession("put_settings_admin");
    const project = await seedProject("_put_settings_admin");
    trackProject(project.id);
    await seedMember({
      projectId: project.id,
      userId: admin.userId,
      role: "ADMIN",
    });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/refund-shield/settings`,
      {
        method: "PUT",
        headers: { cookie: admin.cookie, "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, consentAcknowledged: true }),
      },
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when enabling without consentAcknowledged: true", async () => {
    const owner = await createUserAndSession("put_settings_no_consent");
    const project = await seedProject("_put_no_consent");
    trackProject(project.id);
    await seedMember({
      projectId: project.id,
      userId: owner.userId,
      role: "OWNER",
    });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/refund-shield/settings`,
      {
        method: "PUT",
        headers: { cookie: owner.cookie, "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// GET /responses (list)
// ===========================================================================

describe("GET /dashboard/projects/:projectId/refund-shield/responses", () => {
  it("returns paginated list and filters by status", async () => {
    const viewer = await createUserAndSession("list_resp_viewer");
    const project = await seedProject("_list_resp");
    trackProject(project.id);
    await seedMember({
      projectId: project.id,
      userId: viewer.userId,
      role: "CUSTOMER_SUPPORT",
    });

    const now = Date.now();
    await seedRefundShieldResponse({
      projectId: project.id,
      subscriberId: null,
      suffix: "list_pending",
      status: "PENDING",
      detectedAt: new Date(now - 3000),
    });
    await seedRefundShieldResponse({
      projectId: project.id,
      subscriberId: null,
      suffix: "list_sent",
      status: "SENT",
      detectedAt: new Date(now - 2000),
    });
    await seedRefundShieldResponse({
      projectId: project.id,
      subscriberId: null,
      suffix: "list_failed",
      status: "FAILED",
      detectedAt: new Date(now - 1000),
    });

    const app = buildApp();

    // Unfiltered list — should return all three, newest first.
    const allRes = await app.request(
      `/projects/${project.id}/refund-shield/responses`,
      { headers: { cookie: viewer.cookie } },
    );
    expect(allRes.status).toBe(200);
    const allBody = (await allRes.json()) as {
      data: {
        responses: Array<{ id: string; status: string; detectedAt: string }>;
        nextCursor: string | null;
      };
    };
    expect(allBody.data.responses).toHaveLength(3);
    // newest first
    expect(allBody.data.responses[0]!.status).toBe("FAILED");

    // Status filter — only the SENT row should be returned.
    const sentRes = await app.request(
      `/projects/${project.id}/refund-shield/responses?status=SENT`,
      { headers: { cookie: viewer.cookie } },
    );
    expect(sentRes.status).toBe(200);
    const sentBody = (await sentRes.json()) as {
      data: { responses: Array<{ id: string; status: string }> };
    };
    expect(sentBody.data.responses).toHaveLength(1);
    expect(sentBody.data.responses[0]!.status).toBe("SENT");
  });

  it("returns 401 for unauthenticated requests", async () => {
    const app = buildApp();
    const res = await app.request(
      `/projects/some_project/refund-shield/responses`,
    );
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// GET /responses/:rid (detail)
// ===========================================================================

describe("GET /dashboard/projects/:projectId/refund-shield/responses/:rid", () => {
  it("returns the row including requestPayload when found", async () => {
    const viewer = await createUserAndSession("detail_viewer");
    const project = await seedProject("_detail");
    trackProject(project.id);
    await seedMember({
      projectId: project.id,
      userId: viewer.userId,
      role: "CUSTOMER_SUPPORT",
    });

    const payload = { compatibilityVersion: 2, sample: "yes" };
    const { id } = await seedRefundShieldResponse({
      projectId: project.id,
      subscriberId: null,
      suffix: "detail_ok",
      status: "SENT",
      requestPayload: payload,
    });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/refund-shield/responses/${id}`,
      { headers: { cookie: viewer.cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        response: {
          id: string;
          status: string;
          requestPayload: { sample?: string } | null;
        };
      };
    };
    expect(body.data.response.id).toBe(id);
    expect(body.data.response.status).toBe("SENT");
    expect(body.data.response.requestPayload).toEqual(payload);
  });

  it("returns 404 for an unknown id", async () => {
    const viewer = await createUserAndSession("detail_404");
    const project = await seedProject("_detail_404");
    trackProject(project.id);
    await seedMember({
      projectId: project.id,
      userId: viewer.userId,
      role: "CUSTOMER_SUPPORT",
    });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/refund-shield/responses/rsr_does_not_exist`,
      { headers: { cookie: viewer.cookie } },
    );
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// GET /metrics
// ===========================================================================

describe("GET /dashboard/projects/:projectId/refund-shield/metrics", () => {
  it("returns sent count, win rate, and estimated revenue saved", async () => {
    const viewer = await createUserAndSession("metrics_viewer");
    const project = await seedProject("_metrics");
    trackProject(project.id);
    await seedMember({
      projectId: project.id,
      userId: viewer.userId,
      role: "CUSTOMER_SUPPORT",
    });
    const sub = await seedSubscriber({
      projectId: project.id,
      suffix: "metrics",
    });
    const prod = await seedProduct({
      projectId: project.id,
      suffix: "metrics",
    });

    // Two declined ($9.99 each) + one approved ($4.99) + one
    // outcome-less SENT row.
    await seedPurchase({
      projectId: project.id,
      subscriberId: sub.id,
      productId: prod.id,
      originalTransactionId: `otx_${RUN_ID}_metrics_dec1`,
      priceAmount: "9.99",
    });
    await seedPurchase({
      projectId: project.id,
      subscriberId: sub.id,
      productId: prod.id,
      originalTransactionId: `otx_${RUN_ID}_metrics_dec2`,
      priceAmount: "9.99",
    });
    await seedPurchase({
      projectId: project.id,
      subscriberId: sub.id,
      productId: prod.id,
      originalTransactionId: `otx_${RUN_ID}_metrics_app`,
      priceAmount: "4.99",
    });

    await seedRefundShieldResponse({
      projectId: project.id,
      subscriberId: sub.id,
      suffix: "metrics_dec1",
      status: "SENT",
      outcome: "REFUND_DECLINED",
      originalTransactionId: `otx_${RUN_ID}_metrics_dec1`,
    });
    await seedRefundShieldResponse({
      projectId: project.id,
      subscriberId: sub.id,
      suffix: "metrics_dec2",
      status: "SENT",
      outcome: "REFUND_DECLINED",
      originalTransactionId: `otx_${RUN_ID}_metrics_dec2`,
    });
    await seedRefundShieldResponse({
      projectId: project.id,
      subscriberId: sub.id,
      suffix: "metrics_app",
      status: "SENT",
      outcome: "REFUND_APPROVED",
      originalTransactionId: `otx_${RUN_ID}_metrics_app`,
    });
    await seedRefundShieldResponse({
      projectId: project.id,
      subscriberId: sub.id,
      suffix: "metrics_pending",
      status: "SENT",
      outcome: null,
    });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/refund-shield/metrics`,
      { headers: { cookie: viewer.cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        sentCount: number;
        outcomeCount: number;
        declinedCount: number;
        approvedCount: number;
        reversedCount: number;
        winRate: number;
        estimatedRevenueSavedCents: number;
      };
    };
    expect(body.data.sentCount).toBe(4);
    expect(body.data.outcomeCount).toBe(3);
    expect(body.data.declinedCount).toBe(2);
    expect(body.data.approvedCount).toBe(1);
    expect(body.data.reversedCount).toBe(0);
    // 2 declined / 3 outcomes
    expect(body.data.winRate).toBeCloseTo(2 / 3, 5);
    // 2 * 9.99 == 19.98 → 1998 cents
    expect(body.data.estimatedRevenueSavedCents).toBe(1998);
  });

  it("returns zeros when no data exists in the project", async () => {
    const viewer = await createUserAndSession("metrics_empty");
    const project = await seedProject("_metrics_empty");
    trackProject(project.id);
    await seedMember({
      projectId: project.id,
      userId: viewer.userId,
      role: "CUSTOMER_SUPPORT",
    });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/refund-shield/metrics`,
      { headers: { cookie: viewer.cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        sentCount: number;
        outcomeCount: number;
        winRate: number;
        estimatedRevenueSavedCents: number;
      };
    };
    expect(body.data.sentCount).toBe(0);
    expect(body.data.outcomeCount).toBe(0);
    expect(body.data.winRate).toBe(0);
    expect(body.data.estimatedRevenueSavedCents).toBe(0);
  });
});
