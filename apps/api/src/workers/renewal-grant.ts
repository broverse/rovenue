import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { drizzle } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { grantProductCurrencies } from "../services/purchase-credits";
import {
  RENEWAL_GRANT_EVENT_TYPES,
  RENEWAL_GRANT_QUEUE_NAME,
  type RenewalGrantJob,
} from "../queues/renewal-grants";
import {
  renewalGrantsAppliedTotal,
  renewalGrantsFailedTotal,
} from "../lib/metrics";

const log = logger.child("renewal-grant");

export interface RenewalGrantDeps {
  grant: (args: {
    subscriberId: string;
    productId: string;
    referenceId: string;
    productIdentifier: string;
    trigger: "RENEWAL";
  }) => Promise<void>;
  /** Project-scoped: findProductById is (db, projectId, id), and a
   *  product id must never be resolved across project boundaries. */
  loadProduct: (
    projectId: string,
    productId: string,
  ) => Promise<{ identifier: string } | null>;
}

/**
 * Pure job body. Throws on failure — BullMQ's retry is the delivery
 * guarantee, so swallowing here would silently lose a grant.
 */
export async function runRenewalGrant(
  job: RenewalGrantJob,
  deps: RenewalGrantDeps,
): Promise<"granted" | "skipped"> {
  if (!RENEWAL_GRANT_EVENT_TYPES.includes(job.type)) return "skipped";

  const product = await deps.loadProduct(job.projectId, job.productId);
  if (!product) {
    log.warn("product missing for renewal grant", {
      productId: job.productId,
      revenueEventId: job.revenueEventId,
    });
    return "skipped";
  }

  await deps.grant({
    subscriberId: job.subscriberId,
    productId: job.productId,
    referenceId: job.revenueEventId,
    productIdentifier: product.identifier,
    trigger: "RENEWAL",
  });

  return "granted";
}

const liveDeps: RenewalGrantDeps = {
  grant: (args) => grantProductCurrencies(args),
  loadProduct: async (projectId, productId) => {
    const product = await drizzle.productRepo.findProductById(
      drizzle.db,
      projectId,
      productId,
    );
    return product ? { identifier: product.identifier } : null;
  },
};

export async function ensureRenewalGrantWorker(
  opts: { autoStart?: boolean } = {},
): Promise<{ stop: () => Promise<void> }> {
  if (opts.autoStart === false) return { stop: async () => {} };

  const connection = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
  });

  const worker = new Worker<RenewalGrantJob>(
    RENEWAL_GRANT_QUEUE_NAME,
    async (job) => {
      try {
        const outcome = await runRenewalGrant(job.data, liveDeps);
        if (outcome === "granted") renewalGrantsAppliedTotal.inc();
        return outcome;
      } catch (err) {
        renewalGrantsFailedTotal.inc({
          reason: err instanceof Error ? err.name : "unknown",
        });
        throw err;
      }
    },
    { connection },
  );

  return {
    stop: async () => {
      await worker.close();
      await connection.quit();
    },
  };
}
