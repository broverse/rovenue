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
