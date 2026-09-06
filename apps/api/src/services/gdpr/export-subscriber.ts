import { drizzle } from "@rovenue/db";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { audit } from "../../lib/audit";
import { logger } from "../../lib/logger";

// =============================================================
// GDPR Art. 15 right-to-access — subscriber data export
// =============================================================
//
// Produces a JSON dump of every row a project holds for a single
// subscriber: the subscriber itself plus purchases, access rows,
// and the credit ledger. The endpoint is ADMIN-only and each call
// writes a `subscriber.exported` audit entry so compliance auditors
// can see exactly who requested what on the subscriber's behalf.
//
// The dump is intentionally raw (Record<string, unknown>) — we
// forward the full row surface rather than curating fields, on the
// principle that "everything we hold" is the whole point of an
// Art. 15 response. Callers can post-process for presentation.

const log = logger.child("gdpr:export");

/**
 * HTTP status `exportSubscriber` throws for an already-erased subscriber
 * (Finding 2, roadmap-9a final fix wave) — named so a caller (e.g.
 * workers/dsar-export.ts) can recognise this SPECIFIC, expected outcome
 * apart from a generic 404 or an unexpected error, without re-typing the
 * literal 410 at each call site.
 */
export const SUBSCRIBER_ERASED_STATUS = 410;

export interface ExportSubscriberInput {
  subscriberId: string;
  projectId: string;
  actorUserId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface SubscriberExport {
  subscriber: Record<string, unknown>;
  purchases: Array<Record<string, unknown>>;
  access: Array<Record<string, unknown>>;
  creditLedger: Array<Record<string, unknown>>;
  exportedAt: string;
}

export async function exportSubscriber(
  input: ExportSubscriberInput,
): Promise<SubscriberExport> {
  const { subscribers, purchases, subscriberAccess, creditLedger } =
    drizzle.schema;

  const [subscriberRow] = await drizzle.db
    .select()
    .from(subscribers)
    .where(eq(subscribers.id, input.subscriberId));

  if (!subscriberRow) {
    throw new HTTPException(404, {
      message: `Subscriber not found: ${input.subscriberId}`,
    });
  }
  if (subscriberRow.projectId !== input.projectId) {
    // Treat cross-project lookups as 404 rather than 403 so we don't
    // leak the existence of the subscriber to callers who have access
    // to a different project.
    throw new HTTPException(404, {
      message: `Subscriber not found: ${input.subscriberId}`,
    });
  }
  if (subscriberRow.deletedAt) {
    // Finding 2 (roadmap-9a final fix wave): a subscriber this soft-
    // deleted is the SAME "erased, dead-ended" row
    // `resolveSubscriberForWrite` refuses to write onto — see its
    // `deadEnded` flag and comment (lib/resolve-or-create-subscriber.ts).
    // This is the read-side mirror of that guard: `anonymizeSubscriber`
    // never touches `purchases` / `subscriberAccess` / `creditLedger` —
    // only Postgres's own `subscribers` row and (separately, in
    // workers/dsar-erasure.ts) ClickHouse — so a subscriberId that
    // outlives erasure still has its FULL purchase and credit history
    // sitting under it. Without this check, a DSAR export claimed
    // BEFORE erasure but finishing AFTER it (or the dashboard's own
    // manual GDPR-export tool run against an already-erased row) would
    // read that history straight through and hand back a fresh
    // artifact containing everything the subject asked to have
    // forgotten — the sharpest possible failure of this feature's
    // promise. 410 Gone: the subscriber existed and was reachable when
    // this export was requested; it no longer is, permanently.
    throw new HTTPException(SUBSCRIBER_ERASED_STATUS, {
      message: `Subscriber ${input.subscriberId} has been erased and can no longer be exported`,
    });
  }

  const [purchaseRows, accessRows, ledgerRows] = await Promise.all([
    drizzle.db
      .select()
      .from(purchases)
      .where(eq(purchases.subscriberId, input.subscriberId)),
    drizzle.db
      .select()
      .from(subscriberAccess)
      .where(eq(subscriberAccess.subscriberId, input.subscriberId)),
    drizzle.db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.subscriberId, input.subscriberId)),
  ]);

  await audit({
    projectId: input.projectId,
    userId: input.actorUserId,
    action: "subscriber.exported",
    resource: "subscriber",
    resourceId: input.subscriberId,
    before: null,
    after: null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });

  log.info("subscriber exported", {
    subscriberId: input.subscriberId,
    projectId: input.projectId,
  });

  return {
    subscriber: subscriberRow as unknown as Record<string, unknown>,
    purchases: purchaseRows as unknown as Array<Record<string, unknown>>,
    access: accessRows as unknown as Array<Record<string, unknown>>,
    creditLedger: ledgerRows as unknown as Array<Record<string, unknown>>,
    exportedAt: new Date().toISOString(),
  };
}
