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

import { drizzle } from "@rovenue/db";
import { audit } from "../../lib/audit";
import { registerIntentHandler } from "./intent-executor";

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

        const result = await drizzle.productRepo.updateProduct(
          tx as never,
          ctx.projectId,
          productId,
          {
            metadata: {
              ...(before?.metadata as Record<string, unknown> | undefined ?? {}),
              roviPriceOverride: { amount: price, currency },
            },
          },
        );

        await audit(
          {
            projectId: ctx.projectId,
            userId: ctx.userId,
            action: "product.updated",
            resource: "product",
            resourceId: productId,
            before: before
              ? {
                  metadata: before.metadata as Record<string, unknown> | undefined ?? null,
                }
              : null,
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
}
