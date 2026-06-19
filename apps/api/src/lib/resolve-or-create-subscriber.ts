import { drizzle, type Subscriber } from "@rovenue/db";
import { applyMutations, type SdkPlatform } from "@rovenue/shared";

/**
 * Resolves the subscriber for an inbound public-key /v1/me request by
 * rovenueId (following mergedInto redirects). When none exists yet, creates
 * a minimal anonymous subscriber and returns it, so a brand-new SDK user can
 * read entitlements/credits/access (empty) without a 404. Mirrors the upsert
 * /v1/config already performs. Idempotent: upsertSubscriber is a no-op on
 * (projectId, rovenueId) conflict, so concurrent first-calls converge.
 *
 * `platform` is the SDK-reported first-install platform. It is written into
 * the `platform` attribute ONLY on create (createAttributes); the conflict
 * path never touches attributes, so it stays immutable as a first-install
 * signal even though the SDK sends it on every call.
 */
export async function resolveOrCreateSubscriber(
  projectId: string,
  key: string,
  platform?: SdkPlatform,
): Promise<Subscriber> {
  const existing =
    await drizzle.subscriberRepo.resolveSubscriberByRovenueId(drizzle.db, {
      projectId,
      rovenueId: key,
    });
  if (existing) return existing as Subscriber;
  const createAttributes = platform
    ? applyMutations({}, { platform }, "sdk", new Date().toISOString())
    : {};
  return drizzle.subscriberRepo.upsertSubscriber(drizzle.db, {
    projectId,
    rovenueId: key,
    createAttributes,
  });
}
