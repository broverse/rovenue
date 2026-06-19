// =============================================================
// POST /projects/:projectId/transactions/:id/refund
//
// Integration test for the merchant-initiated refund endpoint.
// Uses real Postgres (Better Auth session) but mocks the
// refundTransaction service so no real store network calls happen.
// =============================================================

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import {
  getDb,
  projects,
  subscribers,
  drizzle,
} from "@rovenue/db";
import { auth } from "../../lib/auth";
import { errorHandler } from "../../middleware/error";
import { transactionsRoute } from "./transactions";

// ---- mock refundTransaction before any imports resolve it ----
vi.mock("../../services/refunds/refund-transaction", () => ({
  refundTransaction: vi.fn(),
}));

import { refundTransaction } from "../../services/refunds/refund-transaction";
const refundMock = refundTransaction as ReturnType<typeof vi.fn>;

// =============================================================
// Helpers
// =============================================================

const RUN_ID = Date.now();
const db = getDb();
const schema = drizzle.schema;

function buildApp() {
  const app = new Hono();
  app.route("/projects/:projectId/transactions", transactionsRoute);
  app.onError(errorHandler);
  return app;
}

async function createUserAndSession(suffix: string): Promise<{ userId: string; cookie: string }> {
  const email = `txrefund_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!txrefund";
  const name = `TxRefund User ${suffix}`;

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

const seededProjectIds: string[] = [];

async function seedProject(suffix: string) {
  const id = `prj_txrefund_${RUN_ID}_${suffix}`;
  await db.insert(projects).values({ id, name: `TxRefund Project ${suffix}` });
  seededProjectIds.push(id);
  return id;
}

async function addMember(projectId: string, userId: string, role: "OWNER" | "ADMIN" | "DEVELOPER" | "GROWTH" | "CUSTOMER_SUPPORT") {
  await db.insert(schema.projectMembers).values({ projectId, userId, role });
}

async function seedSubscriber(projectId: string, suffix: string) {
  const id = `sub_txrefund_${RUN_ID}_${suffix}`;
  await db.insert(subscribers).values({
    id,
    projectId,
    rovenueId: `rov_txrefund_${RUN_ID}_${suffix}`,
  });
  return id;
}

async function seedProduct(projectId: string, suffix: string) {
  const id = `prod_txrefund_${RUN_ID}_${suffix}`;
  await db.insert(schema.products).values({
    id,
    projectId,
    identifier: `com.test.product_${RUN_ID}_${suffix}`,
    type: "SUBSCRIPTION",
    storeIds: {},
    displayName: `Test Product ${suffix}`,
  });
  return id;
}

async function seedPurchase({
  id,
  projectId,
  subscriberId,
  productId,
  store,
  storeTransactionId,
  status,
}: {
  id: string;
  projectId: string;
  subscriberId: string;
  productId: string;
  store: "APP_STORE" | "PLAY_STORE" | "STRIPE" | "MANUAL";
  storeTransactionId: string;
  status: "ACTIVE" | "REFUNDED" | "TRIAL";
}) {
  const now = new Date();
  await db.insert(schema.purchases).values({
    id,
    projectId,
    subscriberId,
    productId,
    store,
    storeTransactionId,
    originalTransactionId: storeTransactionId,
    status,
    purchaseDate: now,
    originalPurchaseDate: now,
    environment: "SANDBOX",
  });
}

async function seedRevenueEvent({
  id,
  projectId,
  subscriberId,
  purchaseId,
  productId,
  store,
}: {
  id: string;
  projectId: string;
  subscriberId: string;
  purchaseId: string;
  productId: string;
  store: "APP_STORE" | "PLAY_STORE" | "STRIPE" | "MANUAL";
}) {
  await db.insert(schema.revenueEvents).values({
    id,
    projectId,
    subscriberId,
    purchaseId,
    productId,
    store,
    type: "INITIAL",
    amount: "9.99",
    currency: "USD",
    amountUsd: "9.99",
    eventDate: new Date(),
  });
}

afterAll(async () => {
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

// =============================================================
// Tests
// =============================================================

describe.sequential("POST /projects/:projectId/transactions/:id/refund", () => {
  let app: ReturnType<typeof buildApp>;
  let projectId: string;
  let authHeaders: Record<string, string>;
  let viewerHeaders: Record<string, string>;

  beforeAll(async () => {
    app = buildApp();

    const owner = await createUserAndSession("owner");
    const viewer = await createUserAndSession("viewer");

    projectId = await seedProject("main");
    await addMember(projectId, owner.userId, "OWNER");
    await addMember(projectId, viewer.userId, "CUSTOMER_SUPPORT");

    authHeaders = { cookie: owner.cookie };
    viewerHeaders = { cookie: viewer.cookie };

    // Seed a subscriber, product, purchase, and revenue_event
    const subscriberId = await seedSubscriber(projectId, "main");
    const productId = await seedProduct(projectId, "main");

    await seedPurchase({
      id: `pu_txrefund_${RUN_ID}_stripe`,
      projectId,
      subscriberId,
      productId,
      store: "STRIPE",
      storeTransactionId: "ch_test_123",
      status: "ACTIVE",
    });

    await seedRevenueEvent({
      id: `rev_txrefund_${RUN_ID}_stripe`,
      projectId,
      subscriberId,
      purchaseId: `pu_txrefund_${RUN_ID}_stripe`,
      productId,
      store: "STRIPE",
    });

    // Also seed an iOS purchase + revenue_event for apple_unsupported test
    await seedPurchase({
      id: `pu_txrefund_${RUN_ID}_ios`,
      projectId,
      subscriberId,
      productId,
      store: "APP_STORE",
      storeTransactionId: "ios_tx_test_456",
      status: "ACTIVE",
    });

    await seedRevenueEvent({
      id: `rev_txrefund_${RUN_ID}_ios`,
      projectId,
      subscriberId,
      purchaseId: `pu_txrefund_${RUN_ID}_ios`,
      productId,
      store: "APP_STORE",
    });
  });

  it("refunds a stripe transaction → 200 refund_requested, audited", async () => {
    refundMock.mockResolvedValueOnce({ ok: true, store: "stripe", reference: "re_test_abc" });

    const res = await app.request(
      `/projects/${projectId}/transactions/rev_txrefund_${RUN_ID}_stripe/refund`,
      { method: "POST", headers: authHeaders },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string; store: string; reference: string } };
    expect(body.data).toEqual({
      status: "refund_requested",
      store: "stripe",
      reference: "re_test_abc",
    });

    // Verify an audit_logs row was written for this transaction
    const auditRows = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.resourceId, `rev_txrefund_${RUN_ID}_stripe`));
    expect(auditRows.length).toBeGreaterThan(0);
    expect(auditRows[0]?.action).toBe("transaction.refunded");
    expect(auditRows[0]?.resource).toBe("transaction");
  });

  it("apple → 422 apple_unsupported", async () => {
    refundMock.mockResolvedValueOnce({
      ok: false,
      code: "apple_unsupported",
      message: "Apple processes App Store refunds; no merchant-initiated refund is available.",
    });

    const res = await app.request(
      `/projects/${projectId}/transactions/rev_txrefund_${RUN_ID}_ios/refund`,
      { method: "POST", headers: authHeaders },
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("already refunded → 409", async () => {
    refundMock.mockResolvedValueOnce({
      ok: false,
      code: "already_refunded",
      message: "This transaction is already refunded or revoked.",
    });

    const res = await app.request(
      `/projects/${projectId}/transactions/rev_txrefund_${RUN_ID}_stripe/refund`,
      { method: "POST", headers: authHeaders },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("HTTP_ERROR");
  });

  it("unknown transaction id → 404", async () => {
    const res = await app.request(
      `/projects/${projectId}/transactions/rev_does_not_exist/refund`,
      { method: "POST", headers: authHeaders },
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("member without refunds:write capability → 403", async () => {
    const res = await app.request(
      `/projects/${projectId}/transactions/rev_txrefund_${RUN_ID}_stripe/refund`,
      { method: "POST", headers: viewerHeaders },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("store_error → 502 STORE_API_ERROR", async () => {
    refundMock.mockResolvedValueOnce({
      ok: false,
      code: "store_error",
      message: "Stripe API error.",
    });

    const res = await app.request(
      `/projects/${projectId}/transactions/rev_txrefund_${RUN_ID}_stripe/refund`,
      { method: "POST", headers: authHeaders },
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("STORE_API_ERROR");
  });

  it("missing_store_ref → 422 VALIDATION_ERROR", async () => {
    refundMock.mockResolvedValueOnce({
      ok: false,
      code: "missing_store_ref",
      message: "No store ref.",
    });

    const res = await app.request(
      `/projects/${projectId}/transactions/rev_txrefund_${RUN_ID}_stripe/refund`,
      { method: "POST", headers: authHeaders },
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("cross-project isolation → 404 when projectId path does not own the event", async () => {
    // Seed a second project with its own owner. Attempt to refund the stripe
    // revenue_event (which belongs to the primary projectId) via the second
    // project's path. The route guards event.projectId !== projectId → 404.
    const otherProjectId = await seedProject("other");
    const otherOwner = await createUserAndSession("other_owner");
    await addMember(otherProjectId, otherOwner.userId, "OWNER");
    const otherAuthHeaders = { cookie: otherOwner.cookie };

    const res = await app.request(
      `/projects/${otherProjectId}/transactions/rev_txrefund_${RUN_ID}_stripe/refund`,
      { method: "POST", headers: otherAuthHeaders },
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
