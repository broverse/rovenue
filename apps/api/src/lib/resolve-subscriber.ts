import { HTTPException } from "hono/http-exception";
import { drizzle, type Subscriber } from "@rovenue/db";

/**
 * Resolves the subscriber for an inbound SDK request. `key` is the value
 * the SDK sent — a `rovenueId` going forward, or a legacy `appUserId`
 * during the migration dual-read window. Follows `mergedInto` redirects.
 */
export async function resolveSubscriber(
  projectId: string,
  key: string,
): Promise<Subscriber> {
  const subscriber =
    await drizzle.subscriberRepo.resolveSubscriberByRovenueIdOrLegacy(
      drizzle.db,
      { projectId, key },
    );
  if (!subscriber) {
    throw new HTTPException(404, { message: `Subscriber ${key} not found` });
  }
  return subscriber as Subscriber;
}
