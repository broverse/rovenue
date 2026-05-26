import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle, db, MemberRole } from "@rovenue/db";
import { assertProjectAccess } from "../../../lib/project-access";
import { isBillingEnabled } from "../../../lib/billing-flags";
import { ok } from "../../../lib/response";

// =============================================================
// GET /dashboard/projects/:projectId/billing/invoices (T22)
// =============================================================
//
// Returns the project's invoice history (Stripe-issued invoices
// mirrored into `billing_invoices` by the webhook handlers in T15).
// Used by the dashboard invoices page (T29).
//
// Decimal fields (`amountDue`, `amountPaid`, `refundedAmount`) come
// out of Drizzle's `numeric(12,4)` mapping as strings — we pass them
// through verbatim so the frontend can render exact values without
// float rounding. The "Refunded" badge is computed client-side from
// `refundedAmount` vs `amountPaid`; the server stays presentation-
// agnostic.
//
// Feature-flagged via `BILLING_ENABLED` like the rest of the
// billing surface. Auth + rate-limit are provided by the parent
// dashboard router tree — `requireDashboardAuth` is NOT re-mounted.

export const invoicesRoute = new Hono().get("/", async (c) => {
  if (!isBillingEnabled()) {
    throw new HTTPException(404, { message: "Not found" });
  }
  const projectId = c.req.param("projectId")!;
  await assertProjectAccess(projectId, c.get("user").id, MemberRole.ADMIN);
  const rows = await drizzle.billingInvoiceRepo.listInvoicesForProject(
    db,
    projectId,
  );
  return c.json(
    ok(
      rows.map((r) => ({
        id: r.id,
        number: r.number,
        status: r.status,
        amountDue: r.amountDue,
        amountPaid: r.amountPaid,
        refundedAmount: r.refundedAmount ?? "0",
        currency: r.currency,
        periodStart: r.periodStart.toISOString(),
        periodEnd: r.periodEnd.toISOString(),
        hostedInvoiceUrl: r.hostedInvoiceUrl,
        pdfUrl: r.pdfUrl,
        createdAt: r.createdAt.toISOString(),
      })),
    ),
  );
});
