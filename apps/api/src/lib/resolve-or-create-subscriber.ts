import { drizzle, type Subscriber } from "@rovenue/db";
import { applyMutations, type SdkPlatform } from "@rovenue/shared";

// =============================================================
// Merge-aware subscriber resolution for SDK write paths
// =============================================================
//
// `upsertSubscriber` conflicts on the FULL (projectId, rovenueId) unique
// index, so it resolves to whichever row currently holds the rovenueId —
// live or soft-deleted. After a `/v1/subscribers/transfer` merge the
// retired row keeps its rovenueId (a device's permanent id), so any SDK
// path that upserts directly forks that device's writes — attributes,
// experiment assignments, telemetry attribution — onto the dead row
// forever. Every SDK write path must resolve the merge chain FIRST and
// only fall back to create when no row exists at all. This mirrors the
// pattern in services/stripe/stripe-webhook.ts and services/identify.ts.

export interface ResolvedSubscriberForWrite {
  subscriber: Subscriber;
  /**
   * True when the rovenueId leads to a soft-deleted row with no live
   * `mergedInto` survivor (e.g. a GDPR-erased subscriber — erasure
   * soft-deletes with rovenueId intact). Callers MUST NOT write new
   * attributes onto such a row: that would re-populate an erased
   * identity. The full unique index also forbids creating a fresh row
   * under the same rovenueId.
   */
  deadEnded: boolean;
}

/**
 * Resolve the live subscriber for a rovenueId (following `mergedInto`
 * redirects), creating a minimal row only when the id is entirely unknown.
 */
export async function resolveSubscriberForWrite(
  projectId: string,
  rovenueId: string,
  createAttributes: unknown = {},
  markSdkInstall = false,
): Promise<ResolvedSubscriberForWrite> {
  const resolved = await drizzle.subscriberRepo.resolveSubscriberByRovenueId(
    drizzle.db,
    { projectId, rovenueId },
  );
  if (resolved) return { subscriber: resolved as Subscriber, deadEnded: false };

  const existing = await drizzle.subscriberRepo.findSubscriberByRovenueId(
    drizzle.db,
    { projectId, rovenueId },
  );
  if (existing) {
    return { subscriber: existing as Subscriber, deadEnded: true };
  }

  const subscriber = await drizzle.subscriberRepo.upsertSubscriber(drizzle.db, {
    projectId,
    rovenueId,
    createAttributes,
    sdkInstalledAt: markSdkInstall ? new Date() : null,
  });
  return { subscriber, deadEnded: false };
}

/**
 * Resolves the subscriber for an inbound public-key /v1 request by
 * rovenueId (following mergedInto redirects). When none exists yet, creates
 * a minimal anonymous subscriber and returns it, so a brand-new SDK user can
 * read entitlements/credits/access (empty) without a 404. Idempotent:
 * upsertSubscriber is a no-op on (projectId, rovenueId) conflict, so
 * concurrent first-calls converge.
 *
 * `platform` is the SDK-reported first-install platform. It is written into
 * the `platform` attribute ONLY on create (createAttributes); the conflict
 * path never touches attributes, so it stays immutable as a first-install
 * signal even though the SDK sends it on every call.
 *
 * Because this wrapper is reachable ONLY from the SDK's public-key /v1
 * surface, creating here IS an install: it stamps `sdkInstalledAt`
 * (insert-only — see the column comment in schema.ts), independently of
 * whether the façade sent a platform header. `resolveSubscriberForWrite`
 * itself does not stamp it: the CSV importer calls that one directly, and
 * services/import/write.ts's rule 6 ("NEVER set `subscribers.platform`. It
 * is SDK first-install truth") governs this column for the same reason.
 */
export async function resolveOrCreateSubscriber(
  projectId: string,
  key: string,
  platform?: SdkPlatform,
): Promise<ResolvedSubscriberForWrite> {
  const createAttributes = platform
    ? applyMutations({}, { platform }, "sdk", new Date().toISOString())
    : {};
  // Returns the pair, not just the subscriber. This wrapper used to
  // destructure `{ subscriber }` and drop `deadEnded` on the floor, so
  // every caller behind it wrote onto soft-deleted rows -- a
  // GDPR-erased subject's next SDK call silently un-erased them.
  // `routes/v1/subscribers.ts` had guarded this all along; the two
  // paths now agree.
  return resolveSubscriberForWrite(projectId, key, createAttributes, true);
}
