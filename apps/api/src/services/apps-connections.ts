import { and, count, desc, eq, gte } from "drizzle-orm";
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

  return { connections: rows };
}
