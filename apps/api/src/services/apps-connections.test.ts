// =============================================================
// apps-connections.test.ts — M5.10 integration tests
// =============================================================
//
// Tests the overlay logic that derives real connection status for
// meta-capi and tiktok-events from integration_connections +
// integration_deliveries tables.
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance.

import { beforeEach, describe, expect, it } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { getDb, drizzle } from "@rovenue/db";
import { readAppConnections } from "./apps-connections";

// ---------------------------------------------------------------------------
// Env bootstrap
// ---------------------------------------------------------------------------
process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

const db = getDb();

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function seedProject(): Promise<string> {
  const id = createId();
  const [project] = await db
    .insert(drizzle.schema.projects)
    .values({ id, name: "Test Project for apps-connections" })
    .returning();
  if (!project) throw new Error("seedProject: no row returned");
  return project.id;
}

async function seedConnection(
  projectId: string,
  opts: {
    providerId: "META_CAPI" | "TIKTOK_EVENTS";
    isEnabled: boolean;
    credentialsHint?: string;
    lastValidatedAt?: Date;
    lastError?: string;
  },
): Promise<string> {
  const id = createId();
  await db.insert(drizzle.schema.integrationConnections).values({
    id,
    projectId,
    providerId: opts.providerId,
    displayName: opts.providerId === "META_CAPI" ? "Meta CAPI" : "TikTok Events",
    credentialsCipher: "v1:test-cipher",
    credentialsHint: opts.credentialsHint ?? "Pixel 1234…5678",
    enabledEvents: ["revenue.RENEWAL"],
    eventMapping: {},
    actionSource: "app",
    isEnabled: opts.isEnabled,
    lastValidatedAt: opts.lastValidatedAt ?? null,
    lastError: opts.lastError ?? null,
  });
  return id;
}

async function seedDelivery(opts: {
  connectionId: string;
  projectId: string;
  providerId: "META_CAPI" | "TIKTOK_EVENTS";
  status: "succeeded" | "dead_letter";
  createdAt: Date;
  errorMessage?: string;
}): Promise<void> {
  const id = createId();
  await db.insert(drizzle.schema.integrationDeliveries).values({
    id,
    connectionId: opts.connectionId,
    projectId: opts.projectId,
    providerId: opts.providerId,
    outboxEventId: createId(),
    eventKey: "revenue.RENEWAL:test",
    status: opts.status,
    createdAt: opts.createdAt,
    updatedAt: opts.createdAt,
    errorMessage: opts.errorMessage ?? null,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("apps-connections overlay", () => {
  let projectId: string;

  beforeEach(async () => {
    projectId = await seedProject();
  });

  it("derives meta-capi as 'connected' when enabled + recent validation + no recent dead_letter", async () => {
    const connId = await seedConnection(projectId, {
      providerId: "META_CAPI",
      isEnabled: true,
      credentialsHint: "Pixel 1234…5678",
      lastValidatedAt: new Date(),
    });

    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    await seedDelivery({
      connectionId: connId,
      projectId,
      providerId: "META_CAPI",
      status: "succeeded",
      createdAt: fiveMinAgo,
    });

    const { connections } = await readAppConnections(projectId);
    const row = connections.find((c) => c.appId === "meta-capi");

    expect(row).toBeDefined();
    expect(row!.status).toBe("connected");
    expect(row!.account).toBe("Pixel 1234…5678");
    expect(row!.lastSyncLabel).toBeDefined();
  });

  it("derives meta-capi as 'error' when there is a dead_letter in the last hour", async () => {
    const connId = await seedConnection(projectId, {
      providerId: "META_CAPI",
      isEnabled: true,
      credentialsHint: "Pixel ABCD…EFGH",
      lastError: "401 invalid token",
    });

    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    await seedDelivery({
      connectionId: connId,
      projectId,
      providerId: "META_CAPI",
      status: "dead_letter",
      createdAt: fiveMinAgo,
      errorMessage: "invalid token",
    });

    const { connections } = await readAppConnections(projectId);
    const row = connections.find((c) => c.appId === "meta-capi");

    expect(row).toBeDefined();
    expect(row!.status).toBe("error");
    expect(row!.errorReason).toBeDefined();
  });

  it("derives meta-capi + tiktok-events as 'available' when no connection exists", async () => {
    const { connections } = await readAppConnections(projectId);

    const metaRow = connections.find((c) => c.appId === "meta-capi");
    const tiktokRow = connections.find((c) => c.appId === "tiktok-events");

    expect(metaRow).toBeDefined();
    expect(metaRow!.status).toBe("available");

    expect(tiktokRow).toBeDefined();
    expect(tiktokRow!.status).toBe("available");
  });
});
