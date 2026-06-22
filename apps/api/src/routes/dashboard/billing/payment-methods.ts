import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle, db, MemberRole } from "@rovenue/db";
import { assertProjectAccess } from "../../../lib/project-access";
import { isBillingEnabled } from "../../../lib/host-mode";
import { getPlatformStripe } from "../../../lib/stripe-billing";
import { ok } from "../../../lib/response";
import { startAddPaymentMethod } from "../../../services/billing/add-payment-method";

// =============================================================
// /dashboard/projects/:projectId/billing/payment-methods (T21)
// =============================================================
//
// CRUD-ish surface backing the dashboard payment-methods page (T28).
//
//   GET  /                  → list cards on this project's customer.
//   POST /                  → start add-card flow (SetupIntent via T9).
//   POST /:pmId/default     → promote a card to default (DB + Stripe).
//   DELETE /:pmId           → detach via Stripe. The
//                             `payment_method.detached` webhook (T16)
//                             removes the local row — the route does
//                             NOT delete it inline.
//
// Phase-2 placeholder: removing the last card on a paid project
// returns 409. P6 will replace that with a proper "downgrade then
// detach" flow so users can fully cancel.
//
// Auth (session + project ADMIN) is enforced via the parent
// dashboard router stack + `assertProjectAccess`.

function ensureEnabled(): void {
  if (!isBillingEnabled()) {
    throw new HTTPException(404, { message: "Not found" });
  }
}

export const paymentMethodsRoute = new Hono()
  .get("/", async (c) => {
    ensureEnabled();
    const projectId = c.req.param("projectId")!;
    await assertProjectAccess(projectId, c.get("user").id, MemberRole.ADMIN);
    const rows =
      await drizzle.billingPaymentMethodRepo.listPaymentMethodsForProject(
        db,
        projectId,
      );
    return c.json(
      ok(
        rows.map((r) => ({
          id: r.id,
          brand: r.brand,
          last4: r.last4,
          expMonth: r.expMonth,
          expYear: r.expYear,
          isDefault: r.isDefault,
          createdAt: r.createdAt.toISOString(),
        })),
      ),
    );
  })
  .post("/", async (c) => {
    ensureEnabled();
    const projectId = c.req.param("projectId")!;
    await assertProjectAccess(projectId, c.get("user").id, MemberRole.ADMIN);
    try {
      const out = await startAddPaymentMethod({ db, projectId });
      return c.json(ok(out));
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "no_customer") {
        throw new HTTPException(409, {
          message: "Upgrade the project first",
        });
      }
      if (code === "billing_disabled") {
        throw new HTTPException(404, { message: "Not found" });
      }
      if (code === "config_missing") {
        throw new HTTPException(503, { message: "Billing misconfigured" });
      }
      throw e;
    }
  })
  .post("/:pmId/default", async (c) => {
    ensureEnabled();
    const projectId = c.req.param("projectId")!;
    const pmId = c.req.param("pmId")!;
    await assertProjectAccess(projectId, c.get("user").id, MemberRole.ADMIN);
    const pm = await drizzle.billingPaymentMethodRepo.findPaymentMethodById(
      db,
      pmId,
    );
    if (!pm || pm.projectId !== projectId) {
      throw new HTTPException(404, { message: "Payment method not found" });
    }
    await drizzle.billingPaymentMethodRepo.setDefaultPaymentMethod(
      db,
      projectId,
      pmId,
    );
    const stripe = getPlatformStripe();
    const sub =
      await drizzle.billingSubscriptionRepo.findBillingSubscriptionByProject(
        db,
        projectId,
      );
    if (stripe && sub?.stripeCustomerId) {
      await stripe.customers.update(sub.stripeCustomerId, {
        invoice_settings: { default_payment_method: pm.stripePaymentMethodId },
      });
    }
    return c.json(ok({ id: pmId }));
  })
  .delete("/:pmId", async (c) => {
    ensureEnabled();
    const projectId = c.req.param("projectId")!;
    const pmId = c.req.param("pmId")!;
    await assertProjectAccess(projectId, c.get("user").id, MemberRole.ADMIN);
    const pm = await drizzle.billingPaymentMethodRepo.findPaymentMethodById(
      db,
      pmId,
    );
    if (!pm || pm.projectId !== projectId) {
      throw new HTTPException(404, { message: "Payment method not found" });
    }
    const all =
      await drizzle.billingPaymentMethodRepo.listPaymentMethodsForProject(
        db,
        projectId,
      );
    const sub =
      await drizzle.billingSubscriptionRepo.findBillingSubscriptionByProject(
        db,
        projectId,
      );
    const isLast = all.length <= 1;
    const isPaid = sub?.state === "active" || sub?.state === "past_due";
    if (isLast && isPaid) {
      throw new HTTPException(409, {
        message:
          "Cannot remove the last card on a paid project (P6: downgrade-then-detach)",
      });
    }
    const stripe = getPlatformStripe();
    if (!stripe) {
      throw new HTTPException(503, { message: "Billing misconfigured" });
    }
    await stripe.paymentMethods.detach(pm.stripePaymentMethodId);
    // The payment_method.detached webhook removes the DB row.
    return c.json(ok({ detaching: true }));
  });
