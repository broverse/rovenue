import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validate } from "../../lib/validate";
import { drizzle } from "@rovenue/db";
import {
  spendVirtualCurrencyRequestSchema,
  type VirtualCurrencyBalances,
} from "@rovenue/shared";
import { requireSecretKey } from "../../middleware/api-key-auth";
import { idempotency } from "../../middleware/idempotency";
import { appUserContext } from "../../middleware/app-user-context";
import { ok } from "../../lib/response";
import {
  getAllBalances,
  spendCredits,
  InsufficientCreditsError,
} from "../../services/credit-engine";
import { resolveSubscriber } from "../../lib/resolve-subscriber";

// =============================================================
// /v1/virtual-currencies — multi-currency read + spend
// =============================================================
//
// GET  /me                          — public/secret key; returns balances map for
//                                     the calling subscriber (via appUserContext).
// GET  /:appUserId                  — secret key; returns balances map for any subscriber.
// POST /:appUserId/:code/transactions — secret key; debits one currency.

/**
 * Build a `{ [currencyCode]: balance }` map for a subscriber. Only
 * currencies belonging to the project are included; currencies with
 * no ledger entry are omitted (balance implicitly 0).
 */
export async function buildBalancesMap(
  projectId: string,
  subscriberId: string,
): Promise<VirtualCurrencyBalances> {
  const [balances, currencies] = await Promise.all([
    getAllBalances(subscriberId),
    drizzle.virtualCurrencyRepo.listVirtualCurrencies(drizzle.db, projectId, {
      includeArchived: true,
    }),
  ]);
  const codeById = new Map(currencies.map((c) => [c.id, c.code]));
  const map: VirtualCurrencyBalances = {};
  for (const b of balances) {
    const code = codeById.get(b.currencyId);
    if (code) map[code] = b.balance;
  }
  return map;
}

export const virtualCurrenciesV1Route = new Hono()
  // -----------------------------------------------------------
  // GET /me — public or secret key; subscriber from context
  // -----------------------------------------------------------
  .get("/me", appUserContext, async (c) => {
    const project = c.get("project");
    const subscriber = c.get("subscriber");
    if (!subscriber) {
      throw new HTTPException(401, { message: "Subscriber context required" });
    }
    const map = await buildBalancesMap(project.id, subscriber.id);
    return c.json(ok({ balances: map }));
  })
  // -----------------------------------------------------------
  // GET /:appUserId — secret key; explicit subscriber lookup
  // -----------------------------------------------------------
  .get("/:appUserId", requireSecretKey, async (c) => {
    const project = c.get("project");
    const appUserId = c.req.param("appUserId");
    const subscriber = await resolveSubscriber(project.id, appUserId);
    const map = await buildBalancesMap(project.id, subscriber.id);
    return c.json(ok({ balances: map }));
  })
  // -----------------------------------------------------------
  // POST /:appUserId/:code/transactions — secret key; debit
  // -----------------------------------------------------------
  .post(
    "/:appUserId/:code/transactions",
    requireSecretKey,
    idempotency,
    validate("json", spendVirtualCurrencyRequestSchema),
    async (c) => {
      const project = c.get("project");
      const appUserId = c.req.param("appUserId");
      const code = c.req.param("code");
      if (!code) throw new HTTPException(400, { message: "Missing code" });
      const body = c.req.valid("json");

      const currency =
        await drizzle.virtualCurrencyRepo.findVirtualCurrencyByCode(
          drizzle.db,
          project.id,
          code,
        );
      if (!currency) {
        throw new HTTPException(404, {
          message: `Unknown currency: ${code}`,
        });
      }

      const subscriber = await resolveSubscriber(project.id, appUserId);

      try {
        const entry = await spendCredits({
          subscriberId: subscriber.id,
          currencyId: currency.id,
          amount: body.amount,
          referenceType: body.referenceType,
          referenceId: body.referenceId,
          description: body.description,
          // referenceId is now required on every spend request, so deduplication
          // is always active — a retried request with the same referenceId is a
          // no-op (returns the original SPEND row) instead of double-debiting.
          dedupeOnReference: true,
        });
        return c.json(ok({ code: currency.code, balance: entry.balance }));
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          throw new HTTPException(409, { message: err.message });
        }
        throw err;
      }
    },
  );
