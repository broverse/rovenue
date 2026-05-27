// =============================================================
// Custom-domain cert-status poller
// =============================================================
//
// Once a row is DNS-verified, Caddy starts issuing a cert in the
// background the first time a client (or this poller) hits the
// hostname over TLS. We poll once a minute, doing a TLS handshake
// against the hostname to inspect the served cert. Status moves:
//
//   pending  → issuing → issued
//                  └→ failed
//
// After 30 minutes without an `issued` outcome we mark the row
// `failed` so the operator gets a useful error in the dashboard.
// Caddy can usually finish ACME in well under a minute; 30 min is
// generous for slow DNS propagation + occasional Let's Encrypt
// staging hiccups.

import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { drizzle } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { invalidateHost } from "../services/custom-domains/host-resolver";
import {
  liveCertProbe,
  type CertProbe,
} from "../services/custom-domains/cert-probe";

const log = logger.child("custom-domain-cert-poller");

export const CUSTOM_DOMAIN_CERT_POLLER_QUEUE_NAME = "rovenue-custom-domain-cert-poller";

const REPEAT_CRON = "* * * * *"; // every 1 minute
const REPEATABLE_JOB_NAME = "custom-domain-cert-poller:sweep";
const REPEATABLE_JOB_ID = "custom-domain-cert-poller-repeatable";

// Window after `verifiedAt` during which we keep polling. Beyond
// this, give up and mark the row failed.
const CERT_ACQUIRE_WINDOW_MS = 30 * 60 * 1000;

// =============================================================
// Job body
// =============================================================

export async function runCustomDomainCertPollerSweep(
  now: Date = new Date(),
  probe: CertProbe = liveCertProbe,
): Promise<{ checked: number; issued: number; failed: number; stillPending: number }> {
  // Verified rows whose cert is still pending/issuing.
  const rows = await drizzle.customDomainRepo.listAwaitingCert(drizzle.db);

  let issued = 0;
  let failed = 0;
  let stillPending = 0;
  let checked = 0;

  for (const row of rows) {
    if (!row.verifiedAt) continue; // listAwaitingCert filter already enforces, defensive
    checked++;

    // Time-out path: row has been awaiting cert for too long. Mark failed
    // without probing (saves a TLS handshake against an expired window).
    if (now.getTime() - row.verifiedAt.getTime() > CERT_ACQUIRE_WINDOW_MS) {
      await drizzle.customDomainRepo.updateById(drizzle.db, row.id, {
        certStatus: "failed",
        certFailureReason: "acquire_window_expired",
      });
      await invalidateHost(row.hostname);
      failed++;
      continue;
    }

    try {
      const result = await probe(row.hostname);
      if (result.status === "issued") {
        await drizzle.customDomainRepo.updateById(drizzle.db, row.id, {
          certStatus: "issued",
          certIssuedAt: now,
          certFailureReason: null,
        });
        // Flip the resolver cache so the next public request sees
        // the row as serveable (was negative-cached otherwise).
        await invalidateHost(row.hostname);
        issued++;
      } else if (result.status === "failed") {
        await drizzle.customDomainRepo.updateById(drizzle.db, row.id, {
          certStatus: "failed",
          certFailureReason: result.reason,
        });
        await invalidateHost(row.hostname);
        failed++;
      } else {
        // Still issuing — bump certStatus to 'issuing' so the dashboard
        // can distinguish "Caddy hasn't even started" from "Caddy is
        // mid-ACME." Don't touch if already 'issuing'.
        if (row.certStatus !== "issuing") {
          await drizzle.customDomainRepo.updateById(drizzle.db, row.id, {
            certStatus: "issuing",
          });
        }
        stillPending++;
      }
    } catch (err) {
      // A single bad probe mustn't kill the whole sweep.
      log.warn("cert probe threw", {
        id: row.id,
        hostname: row.hostname,
        err: err instanceof Error ? err.message : String(err),
      });
      stillPending++;
    }
  }

  if (checked > 0) {
    log.info("custom-domain cert poll done", { checked, issued, failed, stillPending });
  }
  return { checked, issued, failed, stillPending };
}

// =============================================================
// BullMQ queue + worker + scheduling
// =============================================================

function createBullConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
}

let cachedQueue: Queue | undefined;

export function getCustomDomainCertPollerQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(CUSTOM_DOMAIN_CERT_POLLER_QUEUE_NAME, {
    connection: createBullConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 100, age: 24 * 60 * 60 },
      removeOnFail: { count: 500, age: 7 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

export async function scheduleCustomDomainCertPoller(): Promise<void> {
  const queue = getCustomDomainCertPollerQueue();
  await queue.add(
    REPEATABLE_JOB_NAME,
    {},
    {
      jobId: REPEATABLE_JOB_ID,
      repeat: { pattern: REPEAT_CRON },
    },
  );
  log.info("scheduled custom-domain cert poller", { pattern: REPEAT_CRON });
}

let cachedWorker: Worker | undefined;

export function createCustomDomainCertPollerWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    CUSTOM_DOMAIN_CERT_POLLER_QUEUE_NAME,
    async (_job: Job) => {
      return runCustomDomainCertPollerSweep();
    },
    {
      connection: createBullConnection(),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("custom-domain cert poller job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  cachedWorker.on("completed", (job) => {
    log.debug("custom-domain cert poller job completed", { jobId: job.id });
  });

  log.info("custom-domain cert poller worker started", {
    queue: CUSTOM_DOMAIN_CERT_POLLER_QUEUE_NAME,
  });
  return cachedWorker;
}
