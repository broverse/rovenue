// =============================================================
// Intent handlers — per-action tool registrations
// =============================================================
//
// Call `registerAllIntentHandlers()` once at API boot (Task 21).
// Each handler opens a Drizzle transaction, runs the domain repo
// call, then calls `audit()` inside the same tx so the audit row
// commits or rolls back atomically with the mutation.
//
// Repo function discovery summary (worktree base):
//
//   action.subscriptions.cancel  → STUB (no cancelSubscription in subscribers.ts)
//   action.subscriptions.refund  → STUB (no refundPurchaseFull in purchases.ts)
//   action.subscribers.grantAccess → accessRepo.createAccess
//   action.subscribers.transfer  → STUB (no transferSubscriber — reassignPurchases
//                                        + reassignSubscriberAccess exist but are not
//                                        a single atomic transfer fn)
//   action.products.updatePrice  → productRepo.updateProduct (no dedicated updatePrice)
//   action.audiences.create      → audienceRepo.createAudience
//   action.audiences.update      → audienceRepo.updateAudience
//   action.featureFlags.toggle   → dashboardFeatureFlagRepo.updateFeatureFlag
//   action.featureFlags.updateRules → dashboardFeatureFlagRepo.updateFeatureFlag
//   action.experiments.start     → experimentRepo.updateExperiment (status→"RUNNING")
//   action.experiments.stop      → experimentRepo.updateExperiment (status→"COMPLETED")
//   action.paywall.editTree      → paywallRepo.updatePaywallDraft (the
//                                   sole persistence path for an approved
//                                   op — see the handler below).

import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { applyTreeOp, paywallTreeOpSchema } from "@rovenue/shared/paywall";
import { audit } from "../../lib/audit";
import { registerIntentHandler } from "./intent-executor";
// The create schemas are the routes' own validation (dashboard parity:
// the MCP tools validate with these same objects, and the handlers
// re-parse so a forged intent payload cannot smuggle an unvalidated
// shape past the tool boundary). This services→routes import is a
// deliberate, narrow exception to the usual layering.
import { createBodySchema as createProductBodySchema } from "../../routes/dashboard/products";
import { createBodySchema as createOfferingBodySchema } from "../../routes/dashboard/offerings";
import { createBodySchema as createAccessBodySchema } from "../../routes/dashboard/access";
import {
  assertRowRefsOwnedByProject,
  createBodySchema as createPlacementBodySchema,
} from "../../routes/dashboard/placements";
import { purgeProjectCatalogCache } from "../../lib/edge-cache";
import { purgeResolvedPriceCache } from "../offering-price-resolver";
import { logger } from "../../lib/logger";

const log = logger.child("intent-handlers");

/** Fire-and-forget resolved-price cache bust; never blocks or fails the mutation. */
function purgeResolvedPriceCacheSafe(projectId: string): void {
  purgeResolvedPriceCache(projectId).catch((err) => {
    log.warn("resolved-price cache purge failed", {
      projectId,
      err: err instanceof Error ? err.message : String(err),
    });
  });
}
import {
  assertSaveValid,
  BUILDER_CONFIG_TREE_FORMAT_VERSION,
} from "../paywall-ai/validate-config";
import { resolvePaywallDraftConfig } from "./tools/query-paywall";

const editTreePayloadSchema = z.object({
  paywallId: z.string().min(1),
  op: paywallTreeOpSchema,
});

export function registerAllIntentHandlers(): void {
  // ------------------------------------------------------------------
  // action.subscriptions.cancel
  // STUB: subscribers.ts has no cancelSubscription. The domain path
  // involves updating a purchase row and scheduling cancellation via
  // the outbox; that composite operation is not yet exposed as a single
  // repo function in this worktree.
  // ------------------------------------------------------------------
  registerIntentHandler("action_subscriptions_cancel", async (_ctx, _payload) => {
    throw new Error(
      "not implemented: cancelSubscription repo function missing in this worktree",
    );
  });

  // ------------------------------------------------------------------
  // action.subscriptions.refund
  // STUB: purchases.ts has no refundPurchaseFull. Refunds require an
  // App Store / Play Store API call which is handled by a dedicated
  // service not yet wired in this worktree.
  // ------------------------------------------------------------------
  registerIntentHandler("action_subscriptions_refund", async (_ctx, _payload) => {
    throw new Error(
      "not implemented: refundPurchaseFull repo function missing in this worktree",
    );
  });

  // ------------------------------------------------------------------
  // action.subscribers.grantAccess
  // Uses accessRepo.createAccess — creates a complimentary access row.
  // ------------------------------------------------------------------
  registerIntentHandler(
    "action_subscribers_grantAccess",
    async (ctx, payload) => {
      const { subscriberId, accessId, expiresDate } = payload as {
        subscriberId: string;
        accessId: string;
        expiresDate?: string | null;
      };

      return drizzle.db.transaction(async (tx) => {
        // Cross-project guard: the payload's subscriberId is stored verbatim
        // from the AI tool call and the access write is keyed by id alone, so
        // confirm the subscriber belongs to this project before granting.
        const sub = await drizzle.subscriberRepo.findSubscriberById(
          tx as never,
          subscriberId,
        );
        if (!sub || sub.projectId !== ctx.projectId) {
          throw new Error(`Subscriber ${subscriberId} not found in project`);
        }

        // A complimentary grant has no real purchase behind it; we use
        // a sentinel purchaseId derived from the subscriber + access id.
        const sentinelPurchaseId = `manual:${subscriberId}:${accessId}`;

        await drizzle.accessRepo.createAccess(tx, {
          subscriberId,
          purchaseId: sentinelPurchaseId,
          accessId,
          isActive: true,
          expiresDate: expiresDate ? new Date(expiresDate) : null,
          store: "manual" as never, // complimentary grants use "manual" store
        });

        await audit(
          {
            projectId: ctx.projectId,
            userId: ctx.userId,
            action: "subscriber.access_granted",
            resource: "subscriber",
            resourceId: subscriberId,
            after: { accessId, expiresDate: expiresDate ?? null },
          },
          tx as Parameters<typeof audit>[1],
        );

        return { subscriberId, accessId, granted: true };
      });
    },
  );

  // ------------------------------------------------------------------
  // action.subscribers.transfer
  // Multi-step composite: reassign purchases, access rows, and
  // experiment assignments from the source subscriber to the target,
  // then soft-delete the source as merged. All four mutations + audit
  // run inside one transaction.
  // ------------------------------------------------------------------
  registerIntentHandler("action_subscribers_transfer", async (ctx, payload) => {
    const { fromSubscriberId, toSubscriberId, reason } = payload as {
      fromSubscriberId: string;
      toSubscriberId: string;
      reason: string;
    };

    return drizzle.db.transaction(async (tx) => {
      // Validate both subscribers exist and belong to this project.
      const [fromSub, toSub] = await Promise.all([
        drizzle.subscriberRepo.findSubscriberById(tx as never, fromSubscriberId),
        drizzle.subscriberRepo.findSubscriberById(tx as never, toSubscriberId),
      ]);
      if (!fromSub || fromSub.projectId !== ctx.projectId) {
        throw new Error(`Source subscriber ${fromSubscriberId} not found in project`);
      }
      if (!toSub || toSub.projectId !== ctx.projectId) {
        throw new Error(`Target subscriber ${toSubscriberId} not found in project`);
      }
      if (fromSubscriberId === toSubscriberId) {
        throw new Error("Cannot transfer to the same subscriber");
      }

      // Three reassignments, then mark the source as merged.
      await drizzle.subscriberRepo.reassignPurchases(
        tx as never,
        fromSubscriberId,
        toSubscriberId,
      );
      await drizzle.subscriberRepo.reassignSubscriberAccess(
        tx as never,
        fromSubscriberId,
        toSubscriberId,
      );
      await drizzle.subscriberRepo.reassignExperimentAssignments(
        tx as never,
        fromSubscriberId,
        toSubscriberId,
      );
      await drizzle.subscriberRepo.softDeleteSubscriberAsMerged(
        tx as never,
        fromSubscriberId,
        toSubscriberId,
        new Date(),
      );

      await audit(
        {
          projectId: ctx.projectId,
          userId: ctx.userId,
          action: "update",
          resource: "subscriber",
          resourceId: fromSubscriberId,
          after: { mergedInto: toSubscriberId, reason },
        },
        tx as Parameters<typeof audit>[1],
      );

      return {
        fromSubscriberId,
        toSubscriberId,
        transferred: true,
      };
    });
  });

  // ------------------------------------------------------------------
  // action.products.updatePrice
  // Uses productRepo.updateProduct — the UpdateProductInput interface
  // does not have a dedicated price field (pricing is external / store-
  // driven); we patch metadata to record the intended price update.
  // ------------------------------------------------------------------
  registerIntentHandler(
    "action_products_updatePrice",
    async (ctx, payload) => {
      const { productId, price, currency } = payload as {
        productId: string;
        price: number;
        currency: string;
      };

      return drizzle.db.transaction(async (tx) => {
        const before = await drizzle.productRepo.findProductById(
          tx as never,
          ctx.projectId,
          productId,
        );
        if (!before) {
          throw new Error(
            `Product ${productId} not found in project ${ctx.projectId}`,
          );
        }

        const result = await drizzle.productRepo.updateProduct(
          tx as never,
          ctx.projectId,
          productId,
          {
            metadata: {
              ...(before.metadata as Record<string, unknown> | undefined ?? {}),
              roviPriceOverride: { amount: price, currency },
            },
          },
        );
        if (!result) {
          throw new Error(
            `Product ${productId} update affected no rows`,
          );
        }

        await audit(
          {
            projectId: ctx.projectId,
            userId: ctx.userId,
            action: "product.updated",
            resource: "product",
            resourceId: productId,
            before: {
              metadata: before.metadata as Record<string, unknown> | undefined ?? null,
            },
            after: { price, currency },
          },
          tx as Parameters<typeof audit>[1],
        );

        return result;
      });
    },
  );

  // ------------------------------------------------------------------
  // action.audiences.create
  // Uses audienceRepo.createAudience.
  // ------------------------------------------------------------------
  registerIntentHandler("action_audiences_create", async (ctx, payload) => {
    const { name, description, rules } = payload as {
      name: string;
      description?: string;
      rules?: unknown;
    };

    return drizzle.db.transaction(async (tx) => {
      const result = await drizzle.audienceRepo.createAudience(tx, {
        projectId: ctx.projectId,
        name,
        description,
        rules: rules ?? [],
      });

      await audit(
        {
          projectId: ctx.projectId,
          userId: ctx.userId,
          action: "create",
          resource: "audience",
          resourceId: result.id,
          after: { name, description: description ?? null },
        },
        tx as Parameters<typeof audit>[1],
      );

      return result;
    });
  });

  // ------------------------------------------------------------------
  // action.audiences.update
  // Uses audienceRepo.updateAudience.
  // ------------------------------------------------------------------
  registerIntentHandler("action_audiences_update", async (ctx, payload) => {
    const { audienceId, name, description, rules } = payload as {
      audienceId: string;
      name?: string;
      description?: string | null;
      rules?: unknown;
    };

    return drizzle.db.transaction(async (tx) => {
      // Cross-project guard: updateAudience filters by id alone.
      const owned = await drizzle.audienceRepo.findAudienceInProject(
        tx as never,
        ctx.projectId,
        audienceId,
      );
      if (!owned) {
        throw new Error(`Audience ${audienceId} not found in project`);
      }

      const result = await drizzle.audienceRepo.updateAudience(tx, audienceId, {
        name,
        description,
        rules,
      });

      await audit(
        {
          projectId: ctx.projectId,
          userId: ctx.userId,
          action: "update",
          resource: "audience",
          resourceId: audienceId,
          after: { name, description: description ?? null },
        },
        tx as Parameters<typeof audit>[1],
      );

      return result;
    });
  });

  // ------------------------------------------------------------------
  // action.featureFlags.toggle
  // Uses dashboardFeatureFlagRepo.updateFeatureFlag — flips isEnabled.
  // ------------------------------------------------------------------
  registerIntentHandler("action_featureFlags_toggle", async (ctx, payload) => {
    const { flagId, enabled } = payload as {
      flagId: string;
      enabled: boolean;
    };

    return drizzle.db.transaction(async (tx) => {
      // Cross-project guard: updateFeatureFlag filters by id alone.
      const flag = await drizzle.dashboardFeatureFlagRepo.findFeatureFlagById(
        tx as never,
        flagId,
      );
      if (!flag || flag.projectId !== ctx.projectId) {
        throw new Error(`Feature flag ${flagId} not found in project`);
      }

      const result = await drizzle.dashboardFeatureFlagRepo.updateFeatureFlag(
        tx,
        flagId,
        { isEnabled: enabled },
      );

      await audit(
        {
          projectId: ctx.projectId,
          userId: ctx.userId,
          action: "toggle",
          resource: "feature_flag",
          resourceId: flagId,
          after: { isEnabled: enabled },
        },
        tx as Parameters<typeof audit>[1],
      );

      return result;
    });
  });

  // ------------------------------------------------------------------
  // action.featureFlags.updateRules
  // Uses dashboardFeatureFlagRepo.updateFeatureFlag — patches rules.
  // ------------------------------------------------------------------
  registerIntentHandler(
    "action_featureFlags_updateRules",
    async (ctx, payload) => {
      const { flagId, rules } = payload as {
        flagId: string;
        rules: unknown;
      };

      return drizzle.db.transaction(async (tx) => {
        // Cross-project guard: updateFeatureFlag filters by id alone.
        const flag = await drizzle.dashboardFeatureFlagRepo.findFeatureFlagById(
          tx as never,
          flagId,
        );
        if (!flag || flag.projectId !== ctx.projectId) {
          throw new Error(`Feature flag ${flagId} not found in project`);
        }

        const result = await drizzle.dashboardFeatureFlagRepo.updateFeatureFlag(
          tx,
          flagId,
          { rules },
        );

        await audit(
          {
            projectId: ctx.projectId,
            userId: ctx.userId,
            action: "update",
            resource: "feature_flag",
            resourceId: flagId,
            after: { rules },
          },
          tx as Parameters<typeof audit>[1],
        );

        return result;
      });
    },
  );

  // ------------------------------------------------------------------
  // action.experiments.start
  // Uses experimentRepo.updateExperiment — transitions status to RUNNING.
  // ------------------------------------------------------------------
  registerIntentHandler("action_experiments_start", async (ctx, payload) => {
    const { experimentId } = payload as { experimentId: string };

    return drizzle.db.transaction(async (tx) => {
      // Cross-project guard: updateExperiment filters by id alone.
      const owned = await drizzle.experimentRepo.findByIdInProject(
        tx as never,
        experimentId,
        ctx.projectId,
      );
      if (!owned) {
        throw new Error(`Experiment ${experimentId} not found in project`);
      }

      const result = await drizzle.experimentRepo.updateExperiment(
        tx,
        experimentId,
        { status: "RUNNING", startedAt: new Date() },
      );

      await audit(
        {
          projectId: ctx.projectId,
          userId: ctx.userId,
          action: "experiment.started",
          resource: "experiment",
          resourceId: experimentId,
          after: { status: "RUNNING" },
        },
        tx as Parameters<typeof audit>[1],
      );

      return result;
    });
  });

  // ------------------------------------------------------------------
  // action.experiments.stop
  // Uses experimentRepo.updateExperiment — transitions status to COMPLETED.
  // ------------------------------------------------------------------
  registerIntentHandler("action_experiments_stop", async (ctx, payload) => {
    const { experimentId, winnerVariantId } = payload as {
      experimentId: string;
      winnerVariantId?: string;
    };

    return drizzle.db.transaction(async (tx) => {
      // Cross-project guard: updateExperiment filters by id alone.
      const owned = await drizzle.experimentRepo.findByIdInProject(
        tx as never,
        experimentId,
        ctx.projectId,
      );
      if (!owned) {
        throw new Error(`Experiment ${experimentId} not found in project`);
      }

      const result = await drizzle.experimentRepo.updateExperiment(
        tx,
        experimentId,
        {
          status: "COMPLETED",
          completedAt: new Date(),
          ...(winnerVariantId !== undefined ? { winnerVariantId } : {}),
        },
      );

      await audit(
        {
          projectId: ctx.projectId,
          userId: ctx.userId,
          action: "experiment.stopped",
          resource: "experiment",
          resourceId: experimentId,
          after: { status: "COMPLETED", winnerVariantId: winnerVariantId ?? null },
        },
        tx as Parameters<typeof audit>[1],
      );

      return result;
    });
  });

  // ------------------------------------------------------------------
  // action.paywall.editTree
  // Applies the approved `PaywallTreeOp` to the paywall's draft and
  // PERSISTS it, in one transaction with its audit row. This is the sole
  // carrier of persistence for an approved op — the dashboard no longer
  // applies it client-side (see design spec, D1).
  //
  // Only the DRAFT is written. `/v1/placements` serves the published
  // snapshot from `paywall_versions`, so nothing here reaches live
  // traffic until someone publishes.
  // ------------------------------------------------------------------
  registerIntentHandler("action_paywall_editTree", async (ctx, payload) => {
    const { paywallId, op } = editTreePayloadSchema.parse(payload);

    return drizzle.db.transaction(async (tx) => {
      // Cross-project guard: paywallId arrives verbatim from a tool call.
      const paywall = await drizzle.paywallRepo.findPaywallById(
        tx,
        ctx.projectId,
        paywallId,
      );
      if (!paywall) {
        throw new Error(`Paywall ${paywallId} not found in project`);
      }

      const currentDraft = resolvePaywallDraftConfig(paywall);
      const nextDraft = assertSaveValid(applyTreeOp(currentDraft, op));

      const updated = await drizzle.paywallRepo.updatePaywallDraft(
        tx,
        ctx.projectId,
        paywallId,
        paywall.draftRevision,
        {
          builderConfig: nextDraft,
          // A tree op always yields a tree, never the legacy empty shape.
          configFormatVersion: BUILDER_CONFIG_TREE_FORMAT_VERSION,
        },
      );
      if (!updated) {
        throw new Error(
          `Paywall ${paywallId} draft changed during approval; re-run the edit`,
        );
      }

      await audit(
        {
          projectId: ctx.projectId,
          userId: ctx.userId,
          action: "update",
          resource: "paywall",
          resourceId: paywallId,
          before: { draftRevision: paywall.draftRevision },
          after: { draftRevision: updated.draftRevision, op },
        },
        tx as Parameters<typeof audit>[1],
      );

      return { paywallId, draftRevision: updated.draftRevision };
    });
  });

  // ------------------------------------------------------------------
  // action.products.create (MCP create_product)
  // Mirrors POST /dashboard/:projectId/products (products:write):
  // duplicate identifier refused, access-id FKs re-checked, RENEWAL/
  // BOTH grants rejected on non-subscriptions, currencies resolved
  // before setProductGrants. Every check runs against the handler's
  // own tx so the audit row below commits atomically with the product.
  // ------------------------------------------------------------------
  registerIntentHandler("action_products_create", async (ctx, payload) => {
    const body = createProductBodySchema.parse(payload);

    return drizzle.db.transaction(async (tx) => {
      const t = tx as never;
      const existing = await drizzle.productRepo.findProductByIdentifier(
        t,
        ctx.projectId,
        body.identifier,
      );
      if (existing) {
        throw new Error(
          `Product identifier already in use: ${body.identifier}`,
        );
      }

      if (body.accessIds && body.accessIds.length > 0) {
        const rows = await drizzle.accessCatalogRepo.findByIds(t, [
          ...body.accessIds,
        ]);
        const valid = new Set(
          rows.filter((r) => r.projectId === ctx.projectId).map((r) => r.id),
        );
        const missing = body.accessIds.filter((id) => !valid.has(id));
        if (missing.length > 0) {
          throw new Error(`Unknown access ids: ${missing.join(", ")}`);
        }
      }

      if (body.type !== "SUBSCRIPTION") {
        const offending = (body.currencyGrants ?? []).find(
          (g) => g.grantOn === "RENEWAL" || g.grantOn === "BOTH",
        );
        if (offending) {
          throw new Error(
            `grantOn "${offending.grantOn}" requires a SUBSCRIPTION product (renewals only fire for subscriptions)`,
          );
        }
      }

      const row = await drizzle.productRepo.createProduct(t, {
        projectId: ctx.projectId,
        identifier: body.identifier,
        type: body.type,
        displayName: body.displayName,
        storeIds: body.storeIds ?? {},
        accessIds: body.accessIds ?? [],
        isActive: body.isActive ?? true,
        metadata: body.metadata ?? {},
        androidBasePlanId: body.androidBasePlanId ?? null,
        androidOfferId: body.androidOfferId ?? null,
      });

      if (body.currencyGrants !== undefined) {
        for (const g of body.currencyGrants) {
          const vc = await drizzle.virtualCurrencyRepo.findVirtualCurrencyById(
            t,
            ctx.projectId,
            g.currencyId,
          );
          if (!vc) {
            throw new Error(`currency not found: ${g.currencyId}`);
          }
        }
        await drizzle.productCurrencyGrantRepo.setProductGrants(
          t,
          row.id,
          body.currencyGrants,
        );
      }

      purgeProjectCatalogCache(ctx.projectId);
      purgeResolvedPriceCacheSafe(ctx.projectId);

      await audit(
        {
          projectId: ctx.projectId,
          userId: ctx.userId,
          action: "product.created",
          resource: "product",
          resourceId: row.id,
          after: {
            identifier: body.identifier,
            type: body.type,
            displayName: body.displayName,
          },
        },
        tx as Parameters<typeof audit>[1],
      );

      return row;
    });
  });

  // ------------------------------------------------------------------
  // action.offerings.create (MCP create_offering)
  // Mirrors POST /dashboard/:projectId/offerings (products:write):
  // duplicate identifier refused, package productIds re-checked
  // against this project. The repo clears a previous default inside
  // its own (savepoint-nested) transaction.
  // ------------------------------------------------------------------
  registerIntentHandler("action_offerings_create", async (ctx, payload) => {
    const body = createOfferingBodySchema.parse(payload);

    return drizzle.db.transaction(async (tx) => {
      const t = tx as never;
      const existing = await drizzle.offeringRepo.findOfferingByIdentifier(
        t,
        ctx.projectId,
        body.identifier,
      );
      if (existing) {
        throw new Error(
          `Offering identifier already in use: ${body.identifier}`,
        );
      }

      if (body.packages && body.packages.length > 0) {
        const rows = await drizzle.productRepo.findProductsByIds(
          t,
          ctx.projectId,
          body.packages.map((p) => p.productId),
        );
        const found = new Set(rows.map((r) => r.id));
        const missing = body.packages
          .map((p) => p.productId)
          .filter((id) => !found.has(id));
        if (missing.length > 0) {
          throw new Error(`Unknown product ids: ${missing.join(", ")}`);
        }
      }

      const row = await drizzle.offeringRepo.createOffering(t, {
        projectId: ctx.projectId,
        identifier: body.identifier,
        isDefault: body.isDefault ?? false,
        packages: body.packages ?? [],
        metadata: body.metadata ?? {},
      });

      purgeProjectCatalogCache(ctx.projectId);
      purgeResolvedPriceCacheSafe(ctx.projectId);

      await audit(
        {
          projectId: ctx.projectId,
          userId: ctx.userId,
          action: "product_group.created",
          resource: "product_group",
          resourceId: row.id,
          after: { identifier: body.identifier },
        },
        tx as Parameters<typeof audit>[1],
      );

      return row;
    });
  });

  // ------------------------------------------------------------------
  // action.entitlements.create (MCP create_entitlement)
  // Mirrors POST /dashboard/:projectId/access (products:write): the
  // access catalog IS the entitlement store, so "create entitlement"
  // creates an access row. Duplicate identifier refused.
  // ------------------------------------------------------------------
  registerIntentHandler("action_entitlements_create", async (ctx, payload) => {
    const body = createAccessBodySchema.parse(payload);

    return drizzle.db.transaction(async (tx) => {
      const t = tx as never;
      const existing = await drizzle.accessCatalogRepo.findByIdentifier(
        t,
        ctx.projectId,
        body.identifier,
      );
      if (existing) {
        throw new Error(
          `Access identifier '${body.identifier}' already exists`,
        );
      }

      const row = await drizzle.accessCatalogRepo.create(t, {
        projectId: ctx.projectId,
        identifier: body.identifier,
        displayName: body.displayName,
        description: body.description ?? null,
        metadata: body.metadata ?? {},
      });

      await audit(
        {
          projectId: ctx.projectId,
          userId: ctx.userId,
          action: "create",
          resource: "access",
          resourceId: row.id,
          after: {
            identifier: body.identifier,
            displayName: body.displayName,
          },
        },
        tx as Parameters<typeof audit>[1],
      );

      return row;
    });
  });

  // ------------------------------------------------------------------
  // action.placements.create (MCP create_placement)
  // Mirrors POST /dashboard/:projectId/placements (products:write):
  // duplicate identifier refused, row audience/paywall/experiment refs
  // re-checked against this project (dangling/foreign refs fail with
  // INVALID_ROW_REF, never silently stored). The ref check is the
  // route's own exported helper — read-only, so it runs outside the
  // write transaction; create + audit commit atomically inside it.
  // ------------------------------------------------------------------
  registerIntentHandler("action_placements_create", async (ctx, payload) => {
    const body = createPlacementBodySchema.parse(payload);

    if (body.rows) {
      await assertRowRefsOwnedByProject(ctx.projectId, body.rows);
    }

    return drizzle.db.transaction(async (tx) => {
      const t = tx as never;
      const existing = await drizzle.placementRepo.findPlacementByIdentifier(
        t,
        ctx.projectId,
        body.identifier,
      );
      if (existing) {
        throw new Error(
          `Placement identifier already in use: ${body.identifier}`,
        );
      }

      const row = await drizzle.placementRepo.createPlacement(t, {
        projectId: ctx.projectId,
        identifier: body.identifier,
        name: body.name,
        rows: body.rows ?? [],
        ...(body.isActive !== undefined && { isActive: body.isActive }),
      });

      purgeProjectCatalogCache(ctx.projectId);

      await audit(
        {
          projectId: ctx.projectId,
          userId: ctx.userId,
          action: "create",
          resource: "placement",
          resourceId: row.id,
          after: {
            identifier: body.identifier,
            name: body.name,
          },
        },
        tx as Parameters<typeof audit>[1],
      );

      return row;
    });
  });
}
