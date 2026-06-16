import { drizzle, type Subscriber } from "@rovenue/db";

/**
 * Resolves the subscriber for an inbound public-key /v1/me request by
 * rovenueId (following mergedInto redirects). When none exists yet, creates
 * a minimal anonymous subscriber and returns it, so a brand-new SDK user can
 * read entitlements/credits/access (empty) without a 404. Mirrors the upsert
 * /v1/config already performs. Idempotent: upsertSubscriber is a no-op on
 * (projectId, rovenueId) conflict, so concurrent first-calls converge.
 */
export async function resolveOrCreateSubscriber(
  projectId: string,
  key: string,
): Promise<Subscriber> {
  const existing =
    await drizzle.subscriberRepo.resolveSubscriberByRovenueId(drizzle.db, {
      projectId,
      rovenueId: key,
    });
  if (existing) return existing as Subscriber;
  return drizzle.subscriberRepo.upsertSubscriber(drizzle.db, {
    projectId,
    rovenueId: key,
    createAttributes: {},
  });
}
