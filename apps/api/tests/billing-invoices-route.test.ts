import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

// =============================================================
// Route test: GET /dashboard/projects/:projectId/billing/invoices
// =============================================================
// Single happy-path assertion that the route serialises the
// repo rows correctly onto the wire. The repo + access guard +
// feature flag are mocked — repo behaviour has its own unit test
// (billing-invoices-repo.test.ts) and the wire shape is what the
// dashboard contract depends on.

const { listInvoices, isBillingEnabled, assertProjectAccess } = vi.hoisted(
  () => ({
    listInvoices: vi.fn(),
    isBillingEnabled: vi.fn(() => true),
    assertProjectAccess: vi.fn(async () => ({ id: "m1", role: "OWNER" })),
  }),
);

vi.mock("@rovenue/db", async () => {
  const actual =
    await vi.importActual<Record<string, unknown>>("@rovenue/db");
  const drizzle = actual.drizzle as Record<string, unknown>;
  return {
    ...actual,
    db: {},
    drizzle: {
      ...drizzle,
      billingInvoiceRepo: { listInvoicesForProject: listInvoices },
    },
  };
});

vi.mock("../src/lib/host-mode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/host-mode")>();
  return { ...actual, isBillingEnabled };
});
vi.mock("../src/lib/project-access", () => ({ assertProjectAccess }));

import { billingSubRouter } from "../src/routes/dashboard/billing";

function mountAppWithUser() {
  return new Hono()
    .use("*", async (c, next) => {
      c.set("user", { id: "u1", email: "test@example.com" } as never);
      c.set("session", { id: "s1" } as never);
      await next();
    })
    .route("/projects/:projectId/billing", billingSubRouter);
}

describe("GET /dashboard/projects/:projectId/billing/invoices", () => {
  it("returns the wire-serialised list", async () => {
    listInvoices.mockResolvedValue([
      {
        id: "inv_row",
        number: "RV-001",
        status: "paid",
        amountDue: "29.0000",
        amountPaid: "29.0000",
        refundedAmount: "0",
        currency: "usd",
        periodStart: new Date("2026-06-01T00:00:00Z"),
        periodEnd: new Date("2026-07-01T00:00:00Z"),
        hostedInvoiceUrl: "https://stripe.test/invoice/x",
        pdfUrl: null,
        createdAt: new Date("2026-06-01T00:00:00Z"),
      },
    ]);
    const res = await mountAppWithUser().request(
      "/projects/p1/billing/invoices",
    );
    expect(res.status).toBe(200);
    const body: { data: Array<Record<string, unknown>> } = await res.json();
    expect(body.data[0]!.number).toBe("RV-001");
    expect(body.data[0]!.periodStart).toBe("2026-06-01T00:00:00.000Z");
    expect(body.data[0]!.refundedAmount).toBe("0");
  });
});
