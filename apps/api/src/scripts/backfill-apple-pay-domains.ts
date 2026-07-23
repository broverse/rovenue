// =============================================================
// backfill-apple-pay-domains — one-off reconcile
// =============================================================
//
// Projects that connected Stripe before Apple Pay domain registration
// existed never registered the funnel-serving domain, so Apple Pay never
// appears on their paywalls. This walks every active connection and runs
// `registerApplePayDomain`, which is idempotent (it lists first and does
// not create a second domain object) and records Stripe's real verdict —
// so re-running is safe and converges the stored status.
//
// Run once after deploy (the deploy runbook's "Apple Pay reconcile" step),
// with FUNNEL_PAYMENT_DOMAIN set:
//
//   pnpm --filter @rovenue/api apple-pay:backfill
//
// Exits non-zero if any project errored, so a deploy step can surface it.

import { drizzle } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { registerApplePayDomain } from "../services/stripe/apple-pay-domain";

const log = logger.child("backfill:apple-pay-domains");

async function main(): Promise<void> {
  if (!env.FUNNEL_PAYMENT_DOMAIN) {
    log.error(
      "FUNNEL_PAYMENT_DOMAIN is unset — nothing would be registered. Set it and re-run.",
    );
    process.exit(1);
  }

  const connections = await drizzle.stripeConnectionRepo.findAllActive(
    drizzle.db,
  );
  log.info("starting backfill", { connections: connections.length });

  const tally: Record<string, number> = {
    active: 0,
    inactive: 0,
    failed: 0,
    skipped: 0,
  };
  let errored = 0;

  for (const conn of connections) {
    try {
      const outcome = await registerApplePayDomain(conn.projectId);
      tally[outcome] = (tally[outcome] ?? 0) + 1;
      log.info("registered", { projectId: conn.projectId, outcome });
    } catch (err) {
      errored++;
      log.error("registration threw", {
        projectId: conn.projectId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info("backfill complete", { ...tally, errored });
  // `failed` is Stripe's verdict (e.g. verification not yet done) and is a
  // legitimate outcome to record, not a run failure. Only a thrown error
  // makes the run fail so a deploy step notices something genuinely wrong.
  process.exit(errored > 0 ? 1 : 0);
}

main().catch((err) => {
  log.error("backfill crashed", {
    err: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
