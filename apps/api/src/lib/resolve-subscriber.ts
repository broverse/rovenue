import { HTTPException } from "hono/http-exception";
import { drizzle, type Subscriber } from "@rovenue/db";

/**
 * Resolves the subscriber for an inbound SDK request. `key` is the
 * rovenueId the SDK sent. Follows `mergedInto` redirects to the live
 * canonical row.
 */
export async function resolveSubscriber(
  projectId: string,
  key: string,
): Promise<Subscriber> {
  const subscriber =
    await drizzle.subscriberRepo.resolveSubscriberByRovenueId(
      drizzle.db,
      { projectId, rovenueId: key },
    );
  if (!subscriber) {
    throw new HTTPException(404, { message: `Subscriber ${key} not found` });
  }
  return subscriber as Subscriber;
}
