import { HTTPException } from "hono/http-exception";
import { drizzle, type Subscriber } from "@rovenue/db";

export async function resolveSubscriber(
  projectId: string,
  appUserId: string,
): Promise<Subscriber> {
  const subscriber = await drizzle.subscriberRepo.findSubscriberByAppUserId(
    drizzle.db,
    { projectId, appUserId },
  );
  if (!subscriber) {
    throw new HTTPException(404, {
      message: `Subscriber ${appUserId} not found`,
    });
  }
  return subscriber as Subscriber;
}
