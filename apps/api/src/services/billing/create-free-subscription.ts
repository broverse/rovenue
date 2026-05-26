import { drizzle } from "@rovenue/db";

// Wrapper around the repository so callers don't need to import the repo
// directly. Keeps the API surface narrow: the only Phase-1 entrypoint for
// creating a billing row is this service.

export async function createFreeSubscription(
  tx: Parameters<
    typeof drizzle.billingSubscriptionRepo.createFreeBillingSubscription
  >[0],
  projectId: string,
) {
  return drizzle.billingSubscriptionRepo.createFreeBillingSubscription(
    tx,
    projectId,
  );
}
