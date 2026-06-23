import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validate } from "../../lib/validate";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  CreditLedgerType,
  MemberRole,
  drizzle,
} from "@rovenue/db";
import {
  grantCreditsRequestSchema,
  type GrantCreditsResponse,
} from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { idempotency } from "../../middleware/idempotency";
import { assertProjectAccess } from "../../lib/project-access";
import { assertProjectCapability } from "../../lib/capabilities";
import { audit, extractRequestContext } from "../../lib/audit";
import { ok } from "../../lib/response";
import { addCredits } from "../../services/credit-engine";
import {
  __creditsConstants,
  getCreditsRollup,
} from "../../services/metrics/credits";

// =============================================================
// Dashboard: Credits (Phase 3.4 + manual grant)
// =============================================================

const { ROLLUP_WINDOW_DEFAULT_DAYS, ROLLUP_WINDOW_MAX_DAYS } = __creditsConstants;

const rollupQuerySchema = z.object({
  windowDays: z.coerce
    .number()
    .int()
    .min(1)
    .max(ROLLUP_WINDOW_MAX_DAYS)
    .default(ROLLUP_WINDOW_DEFAULT_DAYS),
  currencyCode: z.string().trim().min(1).optional(),
});

export const creditsRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/rollup", validate("query", rollupQuerySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const { windowDays, currencyCode } = c.req.valid("query");

    let currencyId: string | undefined;
    if (currencyCode) {
      const currency = await drizzle.virtualCurrencyRepo.findVirtualCurrencyByCode(
        drizzle.db,
        projectId,
        currencyCode,
      );
      if (!currency) {
        throw new HTTPException(404, { message: "currency not found" });
      }
      currencyId = currency.id;
    }

    const payload = await getCreditsRollup({ projectId, windowDays, currencyId });
    return c.json(ok(payload));
  })
  // -------------------------------------------------------------
  // POST / — manual ledger grant (dashboard "Grant Credits")
  // -------------------------------------------------------------
  //
  // Resolves the subscriber by primary id (scoped to project), then
  // hands off to the credit-engine for the append + advisory lock.
  // The audit row runs *after* the ledger commits because addCredits
  // owns its own transaction; we accept the small atomicity gap so
  // the engine stays the single writer for credit_ledger.
  .post(
    "/",
    // Retry-dangerous: a double-submit (operator double-click, client retry on
    // a slow response) would otherwise append a second ledger row and credit
    // the wallet twice. `idempotency` replays the first response when the
    // client sends a stable Idempotency-Key; `dedupeOnReference` below is the
    // durable DB-level backstop when the grant carries a referenceId.
    idempotency,
    validate("json", grantCreditsRequestSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId) {
        throw new HTTPException(400, { message: "Missing projectId" });
      }
      const user = c.get("user");
      await assertProjectCapability(projectId, user.id, "credits:write");

      const input = c.req.valid("json");

      const [sub] = await drizzle.db
        .select({
          id: drizzle.schema.subscribers.id,
          projectId: drizzle.schema.subscribers.projectId,
        })
        .from(drizzle.schema.subscribers)
        .where(eq(drizzle.schema.subscribers.id, input.subscriberId))
        .limit(1);

      if (!sub || sub.projectId !== projectId) {
        throw new HTTPException(404, { message: "subscriber not found" });
      }

      const currency = await drizzle.virtualCurrencyRepo.findVirtualCurrencyById(
        drizzle.db,
        projectId,
        input.currencyId,
      );
      if (!currency) {
        throw new HTTPException(404, { message: "currency not found" });
      }

      const entry = await addCredits({
        subscriberId: sub.id,
        currencyId: input.currencyId,
        amount: input.amount,
        type: input.type as CreditLedgerType,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        description: input.description,
        // When the operator supplies a (referenceType, referenceId), a
        // duplicate submit returns the original row instead of double-granting.
        dedupeOnReference: true,
      });

      const ctx = extractRequestContext(c);
      await audit({
        projectId,
        userId: user.id,
        action: "subscriber.credits_added",
        resource: "subscriber",
        resourceId: sub.id,
        before: null,
        after: {
          ledgerId: entry.id,
          currencyId: entry.currencyId,
          type: entry.type,
          amount: entry.amount,
          balance: entry.balance,
          referenceType: entry.referenceType,
          referenceId: entry.referenceId,
        },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });

      const response: GrantCreditsResponse = {
        entry: {
          id: entry.id,
          subscriberId: entry.subscriberId,
          currencyId: entry.currencyId,
          type: entry.type,
          amount: entry.amount,
          balance: entry.balance,
          referenceType: entry.referenceType,
          referenceId: entry.referenceId,
          description: entry.description,
          createdAt: entry.createdAt.toISOString(),
        },
        balance: entry.balance,
      };
      return c.json(ok(response));
    },
  );
