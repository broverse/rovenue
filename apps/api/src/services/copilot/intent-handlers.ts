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
import {
  applyTreeOp,
  builderConfigSchema,
  collectMediaUrls,
  isBlockingIssue,
  MAX_BUILDER_DEPTH,
  MAX_BUILDER_NODES,
  measureNodeTree,
  paywallTreeOpSchema,
  validateBuilderConfig,
  type BuilderConfig,
} from "@rovenue/shared/paywall";
import { audit } from "../../lib/audit";
import { deleteObject, parseAssetUrl } from "../../lib/asset-store";
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
import { deleteAssetQuerySchema } from "../../routes/dashboard/assets";
import {
  createFunnelBodySchema,
  updateFunnelBodySchema,
} from "../../routes/dashboard/funnels";
import {
  createBodySchema as createPaywallBodySchema,
  updateBodySchema as updatePaywallBodySchema,
} from "../../routes/dashboard/paywalls";
import { packagesSchema } from "../../lib/offering-hydration";
import { normalizeFunnelSettings } from "../funnel/settings-normalize";
// The dashboard virtual-currencies route validates POST with this same
// shared schema (the route exports no local createBodySchema), so the
// handler re-parses with the identical object — dashboard parity, never
// a re-declaration.
import { createVirtualCurrencyRequestSchema } from "@rovenue/shared";
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
  BUILDER_CONFIG_EMPTY_FORMAT_VERSION,
  BUILDER_CONFIG_TREE_FORMAT_VERSION,
} from "../paywall-ai/validate-config";
import { resolvePaywallDraftConfig } from "./tools/query-paywall";

const editTreePayloadSchema = z.object({
  paywallId: z.string().min(1),
  op: paywallTreeOpSchema,
});

// The dashboard DELETE reads the id from the path and `force` from the
// query; an intent payload carries both, so the payload schema is the
// route's own query schema extended with the path param — the `force`
// validation (enum-then-transform, never coerce) stays exactly the
// dashboard's, and a forged payload cannot smuggle another shape past
// the tool boundary.
const deleteAssetPayloadSchema = deleteAssetQuerySchema.extend({
  id: z.string().min(1),
});

/**
 * Mirror of the DELETE route's `findReferencingPaywalls`
 * (routes/dashboard/assets.ts): the UNION of the published usage index
 * and a walk of every current draft builderConfig, deduped by paywall
 * id. Kept as a local mirror rather than an import because the route's
 * helper is module-private and services must not depend on routes for
 * logic — only for validation schemas (the narrow exception above).
 */
async function findAssetReferencingPaywalls(
  projectId: string,
  assetId: string,
): Promise<{ id: string; name: string }[]> {
  const [published, drafts] = await Promise.all([
    drizzle.assetRepo.listPublishedUsage(drizzle.db, assetId),
    drizzle.paywallRepo.listDraftBuilderConfigs(drizzle.db, projectId),
  ]);
  const referencing = new Map<string, { id: string; name: string }>();
  for (const paywall of published) referencing.set(paywall.id, paywall);
  for (const draft of drafts) {
    if (referencing.has(draft.id)) continue;
    const referenced = collectMediaUrls(
      draft.builderConfig as BuilderConfig,
    ).some((url) => {
      const resolved = parseAssetUrl(url);
      return (
        resolved !== null &&
        resolved.projectId === projectId &&
        resolved.assetId === assetId
      );
    });
    if (referenced) referencing.set(draft.id, { id: draft.id, name: draft.name });
  }
  return [...referencing.values()];
}

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

  // ------------------------------------------------------------------
  // action.assets.delete (MCP delete_asset)
  // Mirrors DELETE /dashboard/:projectId/assets/:id (assets:write):
  // unknown ids are refused, the published + draft in-use guard runs
  // first (`force` skips it entirely, exactly as the dashboard does),
  // and the row is soft-deleted inside a transaction with the audit
  // entry. The bucket object delete stays best-effort AFTER the commit
  // (row first, object second): a storage failure must not surface as
  // a failure once every read path already treats the asset as gone —
  // the orphan sweeper reclaims the object.
  // ------------------------------------------------------------------
  registerIntentHandler("action_assets_delete", async (ctx, payload) => {
    const body = deleteAssetPayloadSchema.parse(payload);

    const asset = await drizzle.assetRepo.findAssetById(
      drizzle.db,
      ctx.projectId,
      body.id,
    );
    if (!asset) {
      throw new Error(`Asset ${body.id} not found in project`);
    }

    if (!body.force) {
      const referencing = await findAssetReferencingPaywalls(
        ctx.projectId,
        body.id,
      );
      if (referencing.length > 0) {
        const refs = referencing
          .map((paywall) => `"${paywall.name}" (${paywall.id})`)
          .join(", ");
        throw new Error(
          `Asset is referenced by ${referencing.length} paywall(s): ${refs}. Re-run with force=true to delete it anyway.`,
        );
      }
    }

    await drizzle.db.transaction(async (tx) => {
      await drizzle.assetRepo.softDeleteAsset(tx, ctx.projectId, body.id);
      await audit(
        {
          projectId: ctx.projectId,
          userId: ctx.userId,
          action: "asset.deleted",
          resource: "paywall_asset",
          resourceId: body.id,
        },
        tx as Parameters<typeof audit>[1],
      );
    });

    try {
      await deleteObject(asset.storageKey);
    } catch (err) {
      log.error(
        "asset row deleted but storage object delete failed; sweeper will reclaim",
        {
          assetId: body.id,
          storageKey: asset.storageKey,
          err: err instanceof Error ? err.message : String(err),
        },
      );
    }

    return { deleted: true };
  });

  // ------------------------------------------------------------------
  // action.virtual_currencies.create (MCP create_virtual_currency)
  // Mirrors POST /dashboard/:projectId/virtual-currencies
  // (virtual-currency:manage): duplicate code refused, active cap of
  // 50 enforced, create + audit commit atomically in one transaction.
  // ------------------------------------------------------------------
  registerIntentHandler("action_virtual_currencies_create", async (ctx, payload) => {
    const body = createVirtualCurrencyRequestSchema.parse(payload);

    return drizzle.db.transaction(async (tx) => {
      const t = tx as never;
      const existing =
        await drizzle.virtualCurrencyRepo.findVirtualCurrencyByCode(
          t,
          ctx.projectId,
          body.code,
        );
      if (existing) {
        throw new Error(`Currency code already in use: ${body.code}`);
      }
      const active =
        await drizzle.virtualCurrencyRepo.countActiveVirtualCurrencies(
          t,
          ctx.projectId,
        );
      if (active >= 50) {
        throw new Error("Maximum of 50 currencies per project");
      }
      const row = await drizzle.virtualCurrencyRepo.createVirtualCurrency(t, {
        projectId: ctx.projectId,
        code: body.code,
        name: body.name,
      });
      await audit(
        {
          projectId: ctx.projectId,
          userId: ctx.userId,
          action: "virtual_currency.created",
          resource: "virtual_currency",
          resourceId: row.id,
          before: null,
          after: { code: row.code, name: row.name },
        },
        tx as Parameters<typeof audit>[1],
      );
      return row;
    });
  });

  // ------------------------------------------------------------------
  // action.funnels.create (MCP create_funnel)
  // Mirrors POST /dashboard/:projectId/funnels (funnels:write): the
  // slug is auto-generated when absent, and create + audit commit
  // atomically in one transaction. The slug helpers are a local mirror
  // of the route's module-private helpers — services must not depend
  // on routes for logic, only for validation schemas.
  // ------------------------------------------------------------------
  registerIntentHandler("action_funnels_create", async (ctx, payload) => {
    const body = createFunnelBodySchema.parse(payload);
    const slug = body.slug ?? `${kebabCaseName(body.name)}-${randomSuffix()}`;

    return drizzle.db.transaction(async (tx) => {
      const row = await drizzle.funnelRepo.insert(tx, {
        projectId: ctx.projectId,
        slug,
        name: body.name,
        createdBy: ctx.userId,
      });
      await audit(
        {
          projectId: ctx.projectId,
          userId: ctx.userId,
          action: "funnel.created",
          resource: "funnel",
          resourceId: row.id,
          after: { name: row.name, slug: row.slug },
        },
        tx as Parameters<typeof audit>[1],
      );
      return row;
    });
  });

  // ------------------------------------------------------------------
  // action.funnels.update (MCP update_funnel)
  // Mirrors PATCH /dashboard/:projectId/funnels/:funnelId
  // (funnels:write): unknown ids are refused, draft JSON columns stay
  // opaque working copies (strict validation happens at publish, never
  // here), camelCase settings are normalized to the snake_case reader
  // shape, and update + audit commit atomically in one transaction.
  // Only the DRAFT is written — nothing here reaches live traffic
  // until someone publishes.
  // ------------------------------------------------------------------
  registerIntentHandler("action_funnels_update", async (ctx, payload) => {
    const { funnelId, ...fields } = updateFunnelPayloadSchema.parse(payload);

    const existing = await drizzle.funnelRepo.findById(drizzle.db, funnelId);
    if (!existing || existing.projectId !== ctx.projectId) {
      throw new Error(`Funnel ${funnelId} not found in project`);
    }

    const patch: Parameters<typeof drizzle.funnelRepo.updateById>[2] = {};
    if (fields.name !== undefined) patch.name = fields.name;
    if (fields.slug !== undefined) patch.slug = fields.slug;
    if (fields.draft_pages_json !== undefined) {
      patch.draftPagesJson = fields.draft_pages_json;
    }
    if (fields.draft_theme_json !== undefined) {
      patch.draftThemeJson = fields.draft_theme_json;
    }
    if (fields.draft_settings_json !== undefined) {
      patch.draftSettingsJson = normalizeFunnelSettings(
        fields.draft_settings_json,
      );
    }
    if (fields.default_locale !== undefined) {
      patch.defaultLocale = fields.default_locale;
    }
    if (fields.locales !== undefined) {
      patch.locales = fields.locales;
    }

    // Cross-field guard for the "only one of the two was sent" case —
    // the body-schema refine only fires when both arrive together.
    const nextDefault = fields.default_locale ?? existing.defaultLocale;
    const nextLocales = fields.locales ?? existing.locales;
    if (!nextLocales.includes(nextDefault)) {
      throw new Error("default_locale must be one of locales");
    }

    return drizzle.db.transaction(async (tx) => {
      const row = await drizzle.funnelRepo.updateById(tx, funnelId, patch);
      if (!row) {
        throw new Error(`Funnel ${funnelId} not found in project`);
      }
      await audit(
        {
          projectId: ctx.projectId,
          userId: ctx.userId,
          action: "funnel.updated",
          resource: "funnel",
          resourceId: funnelId,
          after: { fields: Object.keys(patch) },
        },
        tx as Parameters<typeof audit>[1],
      );
      return row;
    });
  });

  // ------------------------------------------------------------------
  // action.paywalls.create (MCP create_paywall)
  // Mirrors POST /dashboard/:projectId/paywalls (paywalls:write):
  // duplicate identifier refused, offeringId re-checked against this
  // project, builderConfig validated through the same SAVE gate the
  // route applies (save-tier issues 400, publish-tier and warnings
  // persist fine — the publish route catches those). Create + audit
  // commit atomically in one transaction, and the edge catalog cache
  // is purged like the route does — paywalls are served under
  // /v1/placements.
  // ------------------------------------------------------------------
  registerIntentHandler("action_paywalls_create", async (ctx, payload) => {
    const body = createPaywallBodySchema.parse(payload);

    return drizzle.db.transaction(async (tx) => {
      const t = tx as never;
      const existing = await drizzle.paywallRepo.findPaywallByIdentifier(
        t,
        ctx.projectId,
        body.identifier,
      );
      if (existing) {
        throw new Error(
          `Paywall identifier already in use: ${body.identifier}`,
        );
      }

      const offering = await drizzle.offeringRepo.findOfferingById(
        t,
        ctx.projectId,
        body.offeringId,
      );
      if (!offering) {
        throw new Error(`Unknown offeringId: ${body.offeringId}`);
      }

      const builderPatch =
        body.builderConfig !== undefined
          ? preparePaywallBuilderConfigPatch(
              body.builderConfig,
              extractOfferingPackageIds(offering),
            )
          : null;

      const row = await drizzle.paywallRepo.createPaywall(t, {
        projectId: ctx.projectId,
        identifier: body.identifier,
        name: body.name,
        offeringId: body.offeringId,
        remoteConfig: body.remoteConfig,
        ...(builderPatch !== null && {
          builderConfig: builderPatch.builderConfig,
          configFormatVersion: builderPatch.configFormatVersion,
        }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
        metadata: body.metadata ?? {},
      });

      purgeProjectCatalogCache(ctx.projectId);

      await audit(
        {
          projectId: ctx.projectId,
          userId: ctx.userId,
          action: "create",
          resource: "paywall",
          resourceId: row.id,
          after: { identifier: body.identifier, name: body.name },
        },
        tx as Parameters<typeof audit>[1],
      );

      return row;
    });
  });

  // ------------------------------------------------------------------
  // action.paywalls.update (MCP update_paywall)
  // Mirrors PATCH /dashboard/:projectId/paywalls/:id (paywalls:write):
  // unknown ids are refused, `identifier` is immutable once set, an
  // offering change re-validates the builder draft against the NEW
  // offering, and a builderConfig write goes through the same
  // compare-and-swapped draft path (revision mismatch fails closed so
  // a concurrent builder autosave is never clobbered). Update + audit
  // commit atomically in one transaction.
  // ------------------------------------------------------------------
  registerIntentHandler("action_paywalls_update", async (ctx, payload) => {
    const { paywallId, ...fields } = updatePaywallPayloadSchema.parse(payload);

    const existingPaywall = await drizzle.paywallRepo.findPaywallById(
      drizzle.db,
      ctx.projectId,
      paywallId,
    );
    if (!existingPaywall) {
      throw new Error(`Paywall ${paywallId} not found in project`);
    }

    if (
      fields.identifier &&
      fields.identifier !== existingPaywall.identifier
    ) {
      throw new Error("identifier is immutable once set");
    }

    // If offeringId is also changing in this request, builderConfig
    // validation runs against the NEW offering, not the paywall's
    // current one.
    let newOffering: Awaited<
      ReturnType<typeof drizzle.offeringRepo.findOfferingById>
    > | null = null;
    if (fields.offeringId) {
      newOffering = await drizzle.offeringRepo.findOfferingById(
        drizzle.db,
        ctx.projectId,
        fields.offeringId,
      );
      if (!newOffering) {
        throw new Error(`Unknown offeringId: ${fields.offeringId}`);
      }
    }

    let builderPatch: ReturnType<
      typeof preparePaywallBuilderConfigPatch
    > | null = null;
    if (fields.builderConfig !== undefined) {
      if (fields.builderConfig === null) {
        builderPatch = preparePaywallBuilderConfigPatch(null, []);
      } else {
        const offeringForValidation =
          newOffering ??
          (await drizzle.offeringRepo.findOfferingById(
            drizzle.db,
            ctx.projectId,
            existingPaywall.offeringId,
          ));
        if (!offeringForValidation) {
          throw new Error(
            `Unknown offeringId: ${existingPaywall.offeringId}`,
          );
        }
        builderPatch = preparePaywallBuilderConfigPatch(
          fields.builderConfig,
          extractOfferingPackageIds(offeringForValidation),
        );
      }
    }

    const nonDraftPatch: Parameters<typeof drizzle.paywallRepo.updatePaywall>[3] =
      {
        ...(fields.name !== undefined && { name: fields.name }),
        ...(fields.offeringId !== undefined && {
          offeringId: fields.offeringId,
        }),
        ...(fields.remoteConfig !== undefined && {
          remoteConfig: fields.remoteConfig,
        }),
        ...(fields.isActive !== undefined && { isActive: fields.isActive }),
        ...(fields.metadata !== undefined && { metadata: fields.metadata }),
      };

    // The non-draft fields (if any) and the compare-and-swapped draft
    // write happen in ONE transaction: a revision mismatch throws
    // inside it, rolling back both statements, so a caller told "your
    // write failed" never has half of it silently persisted.
    const row = await drizzle.db.transaction(async (tx) => {
      if (Object.keys(nonDraftPatch).length > 0) {
        await drizzle.paywallRepo.updatePaywall(
          tx,
          ctx.projectId,
          paywallId,
          nonDraftPatch,
        );
      }
      let updated = await drizzle.paywallRepo.findPaywallById(
        tx,
        ctx.projectId,
        paywallId,
      );
      if (!updated) {
        throw new Error(`Paywall ${paywallId} not found in project`);
      }
      if (builderPatch !== null) {
        // Capture the narrowed (non-null) value for the closure below —
        // `builderPatch` itself is a `let`, and TS does not carry a
        // narrowing across a captured mutable binding.
        const patch = builderPatch;
        const expectedRevision = fields.draftRevision;
        if (expectedRevision === undefined) {
          // updatePaywallPayloadSchema's refine already requires
          // draftRevision whenever builderConfig is present, so this is
          // unreachable in practice — but it keeps `undefined` from ever
          // reaching the CAS compare if that refine is ever relaxed.
          throw new Error(
            "draftRevision is required when builderConfig is present",
          );
        }
        const drafted = await drizzle.paywallRepo.updatePaywallDraft(
          tx,
          ctx.projectId,
          paywallId,
          expectedRevision,
          {
            builderConfig: patch.builderConfig,
            configFormatVersion: patch.configFormatVersion,
          },
        );
        if (!drafted) {
          throw new Error(
            "Paywall draft changed since it was read; reload and retry",
          );
        }
        updated = drafted;
      }
      await audit(
        {
          projectId: ctx.projectId,
          userId: ctx.userId,
          action: "update",
          resource: "paywall",
          resourceId: paywallId,
          after: { fields: Object.keys({ ...nonDraftPatch, ...(builderPatch !== null ? { builderConfig: true } : {}) }) },
        },
        tx as Parameters<typeof audit>[1],
      );
      return updated;
    });

    purgeProjectCatalogCache(ctx.projectId);
    return row;
  });
}

/**
 * Local mirror of the funnels route's module-private slug helpers
 * (routes/dashboard/funnels.ts): services must not import route logic,
 * only validation schemas.
 */
const FUNNEL_SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomSuffix(len = 4): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out +=
      FUNNEL_SLUG_ALPHABET[
        Math.floor(Math.random() * FUNNEL_SLUG_ALPHABET.length)
      ];
  }
  return out;
}

function kebabCaseName(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "funnel"
  );
}

// The dashboard PATCH reads the id from the path; an intent payload
// carries it, so the payload schema is the route's own update schema
// intersected with the path param — every field validation and refine
// stays exactly the dashboard's, and a forged payload cannot smuggle
// another shape past the tool boundary.
const updateFunnelPayloadSchema = updateFunnelBodySchema.and(
  z.object({ funnelId: z.string().min(1) }),
);

// The dashboard paywalls PATCH reads the id from the path; an intent
// payload carries it, so the payload schema is the route's own update
// schema intersected with the path param — every field validation and
// refine stays exactly the dashboard's. `.extend` cannot apply: the
// update schema carries `.refine`s (a ZodEffects), which `extend` does
// not preserve.
const updatePaywallPayloadSchema = updatePaywallBodySchema.and(
  z.object({ paywallId: z.string().min(1) }),
);

/**
 * Local mirror of the paywalls route's module-private
 * `extractOfferingPackageIds` (routes/dashboard/paywalls.ts): services
 * must not import route logic, only validation schemas.
 */
function extractOfferingPackageIds(offering: {
  packages: unknown;
}): string[] {
  const parsed = packagesSchema.safeParse(offering.packages);
  return parsed.success ? parsed.data.map((p) => p.identifier) : [];
}

/**
 * Local mirror of the paywalls route's module-private
 * `prepareBuilderConfigPatch` (routes/dashboard/paywalls.ts): services
 * must not import route logic, only validation schemas. `null` clears
 * the draft (revert to format 1); a non-null value must pass the same
 * iterative bounds pre-scan, Zod node-tree parse, and SAVE-gate
 * validation. Only `save`-tier issues throw here — `publish`-tier and
 * warnings persist fine and are caught by the publish route. A forged
 * intent payload carrying an oversized or unparseable config fails
 * closed with a plain Error (handlers never mint HTTP statuses).
 */
function preparePaywallBuilderConfigPatch(
  rawBuilderConfig: unknown,
  offeringPackageIds: string[],
): { builderConfig: unknown; configFormatVersion: number } {
  if (rawBuilderConfig === null) {
    return {
      builderConfig: null,
      configFormatVersion: BUILDER_CONFIG_EMPTY_FORMAT_VERSION,
    };
  }

  const bounds = measureNodeTree(rawBuilderConfig);
  if (bounds.depth > MAX_BUILDER_DEPTH || bounds.nodes > MAX_BUILDER_NODES) {
    throw new Error(
      `config exceeds limits (max depth ${MAX_BUILDER_DEPTH}, max nodes ${MAX_BUILDER_NODES})`,
    );
  }

  let parsed: ReturnType<typeof builderConfigSchema.safeParse>;
  try {
    parsed = builderConfigSchema.safeParse(rawBuilderConfig);
  } catch {
    throw new Error("config is not parseable");
  }
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`INVALID_BUILDER_CONFIG: ${details}`);
  }

  const issues = validateBuilderConfig(parsed.data, { offeringPackageIds });
  const blocking = issues.filter(isBlockingIssue);
  if (blocking.length > 0) {
    const details = blocking
      .map((issue) => `${issue.code}: ${issue.message}`)
      .join("; ");
    throw new Error(`INVALID_BUILDER_CONFIG: ${details}`);
  }

  return {
    builderConfig: parsed.data,
    configFormatVersion: BUILDER_CONFIG_TREE_FORMAT_VERSION,
  };
}
