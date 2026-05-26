// =============================================================
// processNotification — integration tests (real Postgres)
// =============================================================

import { describe, expect, it, beforeAll } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { LRUCache } from "lru-cache";
import { eq, sql } from "drizzle-orm";
import { getDb, drizzle as drizzleNs } from "@rovenue/db";
import { processNotification } from "./process-notification";
import type { PrefsCache } from "./prefs-cache";
import type { SendEmailJob, SendPushJob } from "../../queues/notifier";

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

const db = getDb();
const schema = drizzleNs.schema;

// 32 bytes hex
const SIGNING_KEY =
  "0".repeat(64); // OK for tests — never used to verify against external systems
const env = {
  DASHBOARD_URL: "http://localhost:5173",
  UNSUB_SIGNING_KEY: SIGNING_KEY,
  UNSUB_MAILTO: "unsubscribe@rovenue.test",
};

function buildPrefsCache(): PrefsCache {
  return {
    userPrefs: new LRUCache<string, object>({ max: 100, ttl: 60_000 }),
    projectDefaults: new LRUCache<string, object>({ max: 100, ttl: 60_000 }),
    projectMembers: new LRUCache<string, object>({ max: 100, ttl: 60_000 }),
    close: async () => undefined,
  };
}

function buildQueues() {
  const emailJobs: SendEmailJob[] = [];
  const pushJobs: SendPushJob[] = [];
  return {
    emailJobs,
    pushJobs,
    sendEmailQueue: {
      add: async (job: SendEmailJob) => {
        emailJobs.push(job);
      },
    },
    sendPushQueue: {
      add: async (job: SendPushJob) => {
        pushJobs.push(job);
      },
    },
  };
}

async function seedUser(opts?: { email?: string }) {
  const id = createId();
  const now = new Date();
  await db.insert(schema.user).values({
    id,
    name: `user-${id}`,
    email: opts?.email ?? `${id}@example.test`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function seedProject() {
  const [row] = await db
    .insert(schema.projects)
    .values({ name: `proj-${createId()}` })
    .returning();
  if (!row) throw new Error("seedProject: no row");
  return row.id;
}

async function addMember(
  projectId: string,
  userId: string,
  role: "OWNER" | "ADMIN" | "DEVELOPER" | "GROWTH" | "CUSTOMER_SUPPORT",
) {
  await db.insert(schema.projectMembers).values({ projectId, userId, role });
}

async function setUserPreferences(
  userId: string,
  patch: { email?: boolean; push?: boolean },
) {
  const now = new Date();
  const channels: Record<string, boolean> = {};
  if (patch.email !== undefined) channels.email = patch.email;
  if (patch.push !== undefined) channels.push = patch.push;

  // Upsert minimal preferences row (only userId + notifications are
  // load-bearing for this test; the rest have schema defaults).
  await db
    .insert(schema.userPreferences)
    .values({
      userId,
      notifications: { channels, muted_until: null },
    })
    .onConflictDoUpdate({
      target: schema.userPreferences.userId,
      set: {
        notifications: { channels, muted_until: null },
        updatedAt: now,
      },
    });
}

async function suppressEmail(email: string) {
  await drizzleNs.notificationSuppressionRepo.add(db, {
    email,
    reason: "manual",
    source: "test",
  });
}

describe("processNotification", () => {
  beforeAll(async () => {
    // Sanity: the schemas this test depends on must exist.
    await db.execute(sql`SELECT 1`).catch(() => {
      throw new Error(
        "DATABASE_URL not reachable — start the dev compose Postgres before running integration tests",
      );
    });
  });

  it("fans out to two recipients but skips email when one has email off", async () => {
    const projectId = await seedProject();
    const owner = await seedUser();
    const admin = await seedUser();
    await addMember(projectId, owner, "OWNER");
    await addMember(projectId, admin, "ADMIN");
    await setUserPreferences(admin, { email: false });

    const queues = buildQueues();
    const outcome = await processNotification(
      {
        db,
        env,
        prefsCache: buildPrefsCache(),
        sendEmailQueue: queues.sendEmailQueue,
        sendPushQueue: queues.sendPushQueue,
      },
      {
        eventKey: "revenue.anomaly.detected",
        eventId: `anomaly-${createId()}`,
        projectId,
        context: {
          projectId,
          projectName: "Test",
          metric: "mrr",
          direction: "down",
          magnitudePct: -12,
          windowMinutes: 60,
        },
      },
    );

    expect(new Set(outcome.recipientsNotified)).toEqual(new Set([owner, admin]));
    expect(outcome.enqueuedEmail).toHaveLength(1); // only owner has email on
    // owner: email + push + inapp, admin: push + inapp
    expect(outcome.enqueuedPush).toHaveLength(2);
  });

  it("is idempotent on (userId, eventId) — second processing is a no-op", async () => {
    const projectId = await seedProject();
    const owner = await seedUser();
    await addMember(projectId, owner, "OWNER");

    const eventId = `dup-${createId()}`;
    const payload = {
      eventKey: "revenue.anomaly.detected" as const,
      eventId,
      projectId,
      context: {
        projectId,
        projectName: "Test",
        metric: "mrr" as const,
        direction: "down" as const,
        magnitudePct: -5,
        windowMinutes: 30,
      },
    };

    const queues = buildQueues();
    const deps = {
      db,
      env,
      prefsCache: buildPrefsCache(),
      sendEmailQueue: queues.sendEmailQueue,
      sendPushQueue: queues.sendPushQueue,
    };

    const first = await processNotification(deps, payload);
    const second = await processNotification(deps, payload);

    expect(first.recipientsNotified).toEqual([owner]);
    expect(second.recipientsNotified).toEqual([]);
    expect(second.recipientsDuplicate).toEqual([owner]);

    // Only the first run enqueues jobs.
    const totalEnqueued =
      first.enqueuedEmail.length +
      first.enqueuedPush.length +
      second.enqueuedEmail.length +
      second.enqueuedPush.length;
    expect(totalEnqueued).toBe(
      first.enqueuedEmail.length + first.enqueuedPush.length,
    );
    expect(second.enqueuedEmail).toHaveLength(0);
    expect(second.enqueuedPush).toHaveLength(0);
  });

  it("never enqueues push for digest events (pushAllowed=false)", async () => {
    const userId = await seedUser();
    await setUserPreferences(userId, { email: true, push: true });

    const queues = buildQueues();
    const outcome = await processNotification(
      {
        db,
        env,
        prefsCache: buildPrefsCache(),
        sendEmailQueue: queues.sendEmailQueue,
        sendPushQueue: queues.sendPushQueue,
      },
      {
        eventKey: "revenue.digest.daily",
        eventId: `digest-${createId()}`,
        recipients: [userId],
        context: {
          date: "2026-05-26",
          timezone: "UTC",
          sections: [
            {
              projectId: createId(),
              projectName: "P",
              mrr: 1000,
              mrrDelta: 10,
              newSubs: 5,
              churnedSubs: 1,
              refundCount: 0,
              refundTotalCents: 0,
            },
          ],
        },
      },
    );

    expect(outcome.recipientsNotified).toEqual([userId]);
    expect(outcome.enqueuedPush).toHaveLength(0);
    expect(outcome.enqueuedEmail).toHaveLength(1);
  });

  it("writes a suppressed delivery row instead of enqueueing email when the address is on the suppression list", async () => {
    const email = `bounce-${createId()}@example.test`;
    const userId = await seedUser({ email });
    await setUserPreferences(userId, { email: true, push: false });
    await suppressEmail(email);

    const queues = buildQueues();
    const outcome = await processNotification(
      {
        db,
        env,
        prefsCache: buildPrefsCache(),
        sendEmailQueue: queues.sendEmailQueue,
        sendPushQueue: queues.sendPushQueue,
      },
      {
        eventKey: "security.signin.new_device",
        eventId: `signin-${createId()}`,
        recipients: [userId],
        context: {
          userAgent: "Chrome",
          ipAddress: "1.2.3.4",
          whenIso: new Date().toISOString(),
        },
      },
    );

    expect(outcome.recipientsNotified).toEqual([userId]);
    expect(outcome.enqueuedEmail).toHaveLength(0);

    // Verify the delivery row exists with status='suppressed'.
    const [notif] = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userId))
      .limit(1);
    expect(notif).toBeDefined();
    const deliveries = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.notificationId, notif!.id));
    const emailRow = deliveries.find((d) => d.channel === "email");
    expect(emailRow?.status).toBe("suppressed");
  });
});
