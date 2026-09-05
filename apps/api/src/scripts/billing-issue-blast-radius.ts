// =============================================================
// billing-issue-blast-radius — read-only pre-deploy report
// =============================================================
//
// An earlier task in this plan added a BILLING_ISSUE status and routed
// Apple billing-retry-without-grace and Stripe unpaid/incomplete rows to
// it. Those transitions used to map to GRACE_PERIOD, which grants access;
// BILLING_ISSUE does not. No migration reclassifies an existing row — the
// change rolls in only as new store notifications arrive — but before
// deploying, the operator should know the ceiling: how many currently
// ENTITLED subscribers could lose access as those notifications land.
//
// "Entitled" here means exactly what the SDK's read path
// (access-engine.ts's hasAccess/getActiveAccess, backed by
// accessRepo.findActiveAccess) would return today: a subscriber_access
// row that is active and not expired. It deliberately does NOT mean
// "any GRACE_PERIOD purchase" — two later tasks in this plan changed
// what GRACE_PERIOD means:
//
//   - computeDesiredAccess (access-engine.ts) now treats a GRACE_PERIOD
//     purchase as live until gracePeriodExpires (falling back to
//     expiresDate when the store didn't state a window), not until
//     expiresDate alone.
//   - The expiry sweeper no longer retires a grace row whose window is
//     still open.
//
// subscriber_access.expiresDate is written by syncAccess from that same
// computeDesiredAccess result, so it already carries the grace-extended
// date. Joining purchases to subscriber_access on isActive alone (as an
// earlier draft of this report did) would overcount: a subscriber_access
// row can still be isActive=true after its expiresDate has passed if the
// reconciler hasn't run since, and such a row grants nothing —
// findActiveAccess would not return it. Re-deriving findActiveAccess's
// own predicate here (isActive AND (expiresDate IS NULL OR expiresDate >
// now())) keeps this report's notion of "entitled" identical to the
// SDK's, instead of drifting from it.
//
// This is still a CEILING, not a prediction: only rows whose next store
// event reports a non-grace billing failure actually move. Many will
// renew successfully and never transition at all.
//
// Usage:
//   pnpm --filter @rovenue/api billing-issue:blast-radius
import { sql } from "drizzle-orm";
import { drizzle, PurchaseStatus, Store } from "@rovenue/db";

interface BlastRadiusRow {
  store: string;
  rows: string;
  subscribers: string;
}

async function main(): Promise<void> {
  const result = await drizzle.db.execute(sql`
    SELECT p."store"                          AS "store",
           count(*)                           AS "rows",
           count(DISTINCT p."subscriberId")   AS "subscribers"
    FROM "purchases" p
    JOIN "subscriber_access" sa
      ON sa."purchaseId" = p."id"
     AND sa."isActive"
     AND (sa."expiresDate" IS NULL OR sa."expiresDate" > now())
    WHERE p."status" = ${PurchaseStatus.GRACE_PERIOD}
      AND p."store" IN (${Store.APP_STORE}, ${Store.STRIPE})
    GROUP BY p."store"
    ORDER BY p."store"
  `);
  const rows = (result as unknown as { rows: BlastRadiusRow[] }).rows ?? [];

  if (rows.length === 0) {
    console.log(
      "No currently-entitled GRACE_PERIOD rows on Apple or Stripe in this " +
        "database. That is a real answer for THIS database, not proof the " +
        "mapping change is safe everywhere — re-run against any environment " +
        "you are about to deploy to.",
    );
    return;
  }

  console.log("Ceiling for entitlement loss when BILLING_ISSUE ships:");
  for (const row of rows) {
    console.log(
      `  ${row.store}: ${row.rows} purchases across ${row.subscribers} subscribers`,
    );
  }
  // No cross-store total: a subscriber entitled via both Apple and Stripe
  // would be double-counted by summing the per-store subscriber columns
  // above, and Apple's and Stripe's triggering conditions differ enough
  // (billing-retry-without-grace vs. unpaid/incomplete) that the per-store
  // split is the number an operator should act on, not a combined one.
  console.log(
    "\nThis is a CEILING, not a prediction: only rows whose next store event\n" +
      "reports a non-grace billing failure actually move to BILLING_ISSUE.\n" +
      "Many will renew successfully and never transition at all. Keep this\n" +
      "number and compare it against a re-run a week after deploy.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
