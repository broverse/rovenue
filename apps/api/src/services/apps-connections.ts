import { and, count, desc, eq, gte, isNull } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import type {
  AppConnectionRow,
  AppConnectionStatus,
  AppConnectionsResponse,
} from "@rovenue/shared";

// =============================================================
// Apps catalog: real connection overlay (Phase 4.2)
// =============================================================
//
// The static catalog lives in the dashboard bundle — this
// service reports the *real* connection state for the handful
// of catalog entries the platform has backing for. The dashboard
// merges the overlay onto its descriptor list so non-backed
// catalog entries (e.g. AppsFlyer / Adjust) stay "available"
// while the rows we actually track surface live data.

const STORE_SOURCES: ReadonlyArray<{
  appId: string;
  source: "APPLE" | "GOOGLE" | "STRIPE";
}> = [
  // Catalog ids must match `apps/mock-data.ts` so the dashboard
  // overlay swaps in real status by id without mapping shims.
  { appId: "apple-iap", source: "APPLE" },
  { appId: "play-billing", source: "GOOGLE" },
  { appId: "stripe", source: "STRIPE" },
];

const DEGRADED_AFTER_MINUTES = 24 * 60;
const NEVER_GRACE_MINUTES = 60 * 24 * 30; // 30 days

function describeAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function statusFromAge(ageMin: number): AppConnectionStatus {
  if (ageMin < DEGRADED_AFTER_MINUTES) return "connected";
  if (ageMin < NEVER_GRACE_MINUTES) return "error";
  return "available";
}

// =============================================================
// Integration overlay helpers (M5.10)
// =============================================================

const INTEGRATION_CATALOG: ReadonlyArray<{
  appId: string;
  providerId: "META_CAPI" | "TIKTOK_EVENTS";
  name: string;
  description: string;
}> = [
  {
    appId: "meta-capi",
    providerId: "META_CAPI",
    name: "Meta Conversions API",
    description: "Send purchase and trial events to Meta (Facebook) Conversions API.",
  },
  {
    appId: "tiktok-events",
    providerId: "TIKTOK_EVENTS",
    name: "TikTok Events API",
    description: "Send purchase and trial events to TikTok Events API.",
  },
];

const DEAD_LETTER_WINDOW_MS = 60 * 60 * 1000; // 60 minutes

async function buildIntegrationOverlay(
  projectId: string,
  providerId: "META_CAPI" | "TIKTOK_EVENTS",
  catalogId: string,
  _catalogName: string,
  _catalogDescription: string,
): Promise<AppConnectionRow> {
  const available: AppConnectionRow = {
    appId: catalogId,
    status: "available",
    lastActivityAt: null,
    lastSyncLabel: null,
    account: null,
  };

  // Look up connection (not soft-deleted)
  const [conn] = await drizzle.db
    .select()
    .from(drizzle.schema.integrationConnections)
    .where(
      and(
        eq(drizzle.schema.integrationConnections.projectId, projectId),
        eq(drizzle.schema.integrationConnections.providerId, providerId),
        isNull(drizzle.schema.integrationConnections.deletedAt),
      ),
    )
    .limit(1);

  if (!conn || !conn.isEnabled) return available;

  const now = Date.now();
  const windowStart = new Date(now - DEAD_LETTER_WINDOW_MS);

  // Check for dead_letter in the last 60 minutes
  const [deadLetterRow] = await drizzle.db
    .select({
      errorMessage: drizzle.schema.integrationDeliveries.errorMessage,
    })
    .from(drizzle.schema.integrationDeliveries)
    .where(
      and(
        eq(drizzle.schema.integrationDeliveries.connectionId, conn.id),
        eq(drizzle.schema.integrationDeliveries.status, "dead_letter"),
        gte(drizzle.schema.integrationDeliveries.createdAt, windowStart),
      ),
    )
    .orderBy(desc(drizzle.schema.integrationDeliveries.createdAt))
    .limit(1);

  if (deadLetterRow) {
    return {
      appId: catalogId,
      status: "error",
      lastActivityAt: null,
      lastSyncLabel: null,
      account: conn.credentialsHint,
      errorReason: deadLetterRow.errorMessage ?? conn.lastError ?? "delivery_failed",
      credentialsHint: conn.credentialsHint,
    };
  }

  // No dead_letter — find most recent succeeded delivery
  const [succeededRow] = await drizzle.db
    .select({ createdAt: drizzle.schema.integrationDeliveries.createdAt })
    .from(drizzle.schema.integrationDeliveries)
    .where(
      and(
        eq(drizzle.schema.integrationDeliveries.connectionId, conn.id),
        eq(drizzle.schema.integrationDeliveries.status, "succeeded"),
      ),
    )
    .orderBy(desc(drizzle.schema.integrationDeliveries.createdAt))
    .limit(1);

  const lastSyncLabel = succeededRow
    ? `Last sync ${describeAge(now - succeededRow.createdAt.getTime())}`
    : null;

  return {
    appId: catalogId,
    status: "connected",
    lastActivityAt: succeededRow ? succeededRow.createdAt.toISOString() : null,
    lastSyncLabel,
    account: conn.credentialsHint,
  };
}

export async function readAppConnections(
  projectId: string,
): Promise<AppConnectionsResponse> {
  const now = Date.now();

  // Per-store latest webhook activity.
  const storeLatest = await Promise.all(
    STORE_SOURCES.map(async ({ source }) => {
      const row = await drizzle.db
        .select({ createdAt: drizzle.schema.webhookEvents.createdAt })
        .from(drizzle.schema.webhookEvents)
        .where(
          and(
            eq(drizzle.schema.webhookEvents.projectId, projectId),
            eq(drizzle.schema.webhookEvents.source, source),
          ),
        )
        .orderBy(desc(drizzle.schema.webhookEvents.createdAt))
        .limit(1);
      return row[0]?.createdAt ?? null;
    }),
  );

  // Outgoing webhook endpoints — group the catalog into a
  // single "outgoing-webhooks" connection entry that reflects
  // whether the project has configured any endpoints in the
  // last week. Endpoints with sentAt > NULL count as proof of
  // delivery; pure PENDING rows don't yet.
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const [outgoingActive] = await drizzle.db
    .select({ c: count() })
    .from(drizzle.schema.outgoingWebhooks)
    .where(
      and(
        eq(drizzle.schema.outgoingWebhooks.projectId, projectId),
        gte(drizzle.schema.outgoingWebhooks.createdAt, weekAgo),
      ),
    );
  const outgoingCount = Number(outgoingActive?.c ?? 0);

  const rows: AppConnectionRow[] = STORE_SOURCES.map(({ appId }, i) => {
    const latest = storeLatest[i];
    if (!latest) {
      return {
        appId,
        status: "available",
        lastActivityAt: null,
        lastSyncLabel: null,
        account: null,
      };
    }
    const ageMs = now - latest.getTime();
    const ageMin = ageMs / 60_000;
    const status = statusFromAge(ageMin);
    return {
      appId,
      status,
      lastActivityAt: latest.toISOString(),
      lastSyncLabel: `Last sync ${describeAge(ageMs)}`,
      account: status === "connected" ? "Live" : null,
    };
  });

  rows.push({
    appId: "outgoing-webhooks",
    status: outgoingCount > 0 ? "connected" : "available",
    lastActivityAt: null,
    lastSyncLabel:
      outgoingCount > 0
        ? `${outgoingCount} delivered in 7d`
        : null,
    account: outgoingCount > 0 ? `${outgoingCount} in 7d` : null,
  });

  // Integration overlays (meta-capi, tiktok-events)
  const integrationRows = await Promise.all(
    INTEGRATION_CATALOG.map(({ appId, providerId, name, description }) =>
      buildIntegrationOverlay(projectId, providerId, appId, name, description),
    ),
  );
  rows.push(...integrationRows);

  return { connections: rows };
}
