// =============================================================
// digest-scheduler — integration tests
// =============================================================
//
// Drives `runDailyTick` against real Postgres + ClickHouse with
// a fixed clock so only one timezone bucket fires per case. The
// scheduler is decoupled from BullMQ so we don't need Redis here;
// the entry file (digest-scheduler-entry.ts) is the only piece
// that touches BullMQ and gets covered by manual smoke runs.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import {
  createClient,
  type ClickHouseClient,
} from "@clickhouse/client";
import { drizzle, getDb } from "@rovenue/db";
import { logger } from "../lib/logger";
import { runDailyTick } from "./digest-scheduler";

const db = getDb();
const schema = drizzle.schema;

interface RawRow {
  eventId: string;
  revenueEventId: string;
  projectId: string;
  subscriberId: string;
  purchaseId: string;
  productId: string;
  type: string;
  store: string;
  amount: string;
  amountUsd: string;
  currency: string;
  eventDate: string;
  ingestedAt: string;
  _version: number;
}

function makeRow(input: {
  projectId: string;
  subscriberId: string;
  type: string;
  amountUsd: number;
  eventDate: string;
}): RawRow {
  const now = new Date().toISOString().replace("T", " ").slice(0, 23);
  return {
    eventId: createId(),
    revenueEventId: createId(),
    projectId: input.projectId,
    subscriberId: input.subscriberId,
    purchaseId: createId(),
    productId: "prod-test",
    type: input.type,
    store: "ios",
    amount: input.amountUsd.toFixed(4),
    amountUsd: input.amountUsd.toFixed(4),
    currency: "USD",
    eventDate: `${input.eventDate} 12:00:00.000`,
    ingestedAt: now,
    _version: 1,
  };
}

async function seedUserWithTimezone(tz: string): Promise<string> {
  const userId = createId();
  const now = new Date();
  await db.insert(schema.user).values({
    id: userId,
    name: `u-${userId}`,
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.userPreferences).values({
    userId,
    timezone: tz,
    notifications: { channels: { email: true, push: true } },
  });
  return userId;
}

async function seedProjectMembership(
  userId: string,
  projectName: string,
): Promise<string> {
  const [proj] = await db
    .insert(schema.projects)
    .values({ name: projectName })
    .returning();
  if (!proj) throw new Error("seedProjectMembership: no project");
  await db.insert(schema.projectMembers).values({
    projectId: proj.id,
    userId,
    role: "OWNER",
  });
  return proj.id;
}

describe.sequential("digest-scheduler runDailyTick (integration)", () => {
  let ch: ClickHouseClient;

  beforeAll(() => {
    ch = createClient({
      url: process.env.CLICKHOUSE_URL ?? "http://localhost:8124",
      username: process.env.CLICKHOUSE_USER ?? "rovenue",
      password: process.env.CLICKHOUSE_PASSWORD ?? "rovenue",
      database: "rovenue",
    });
  });

  afterAll(async () => {
    await ch.close();
  });

  async function insertRows(rows: RawRow[]): Promise<void> {
    await ch.insert({
      table: "rovenue.raw_revenue_events",
      values: rows,
      format: "JSONEachRow",
    });
  }

  it("emits a digest outbox row for the user whose tz hits 09:00 local", async () => {
    // 2026-05-26T06:00:00Z is 09:00 in Istanbul (UTC+3) and
    // 06:00 in UTC, so only the Istanbul user should fire.
    const fixedNow = new Date("2026-05-26T06:00:00Z");

    const istanbulUser = await seedUserWithTimezone("Europe/Istanbul");
    const utcUser = await seedUserWithTimezone("UTC");
    const projectId = await seedProjectMembership(
      istanbulUser,
      `digest-int-${createId()}`,
    );
    // Also give the UTC user a project so we can prove its
    // exclusion comes from the tz check, not the empty-project guard.
    const utcProjectId = await seedProjectMembership(
      utcUser,
      `digest-int-${createId()}`,
    );

    // KPIs land on the prior day (yesterday in the user's tz).
    // Istanbul tz on 2026-05-26T06:00Z → local 2026-05-26 09:00,
    // so the digest covers 2026-05-25.
    await insertRows([
      makeRow({
        projectId,
        subscriberId: createId(),
        type: "INITIAL",
        amountUsd: 100,
        eventDate: "2026-05-25",
      }),
      // UTC user — same eventDate — shouldn't be emitted regardless.
      makeRow({
        projectId: utcProjectId,
        subscriberId: createId(),
        type: "INITIAL",
        amountUsd: 9999,
        eventDate: "2026-05-25",
      }),
    ]);

    const outcome = await runDailyTick({
      db,
      ch,
      logger,
      now: () => fixedNow,
    });

    expect(outcome.targetTimezones).toContain("Europe/Istanbul");
    expect(outcome.targetTimezones).not.toContain("UTC");

    // Outbox row exists for the Istanbul user.
    const outboxRows = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.eventType, "revenue.digest.daily"));

    const matching = outboxRows.filter((r) => {
      const p = r.payload as { recipients?: string[] };
      return p.recipients?.includes(istanbulUser);
    });
    expect(matching).toHaveLength(1);
    const matchingPayload = matching[0]!.payload as {
      recipients: string[];
      eventId: string;
      context: {
        date: string;
        timezone: string;
        sections: Array<{ projectId: string; mrr: number; newSubs: number }>;
      };
    };
    expect(matchingPayload.context.timezone).toBe("Europe/Istanbul");
    expect(matchingPayload.context.date).toBe("2026-05-25");
    expect(matchingPayload.context.sections).toHaveLength(1);
    expect(matchingPayload.context.sections[0]?.projectId).toBe(projectId);
    expect(matchingPayload.context.sections[0]?.mrr).toBe(100_00);
    expect(matchingPayload.context.sections[0]?.newSubs).toBe(1);

    // No outbox row for the UTC user.
    const utcMatching = outboxRows.filter((r) => {
      const p = r.payload as { recipients?: string[] };
      return p.recipients?.includes(utcUser);
    });
    expect(utcMatching).toHaveLength(0);
  });

  it("skips users with no project activity in the window", async () => {
    const fixedNow = new Date("2026-05-26T06:00:00Z");
    const istanbulUser = await seedUserWithTimezone("Europe/Istanbul");
    await seedProjectMembership(istanbulUser, `digest-int-${createId()}`);
    // No CH rows inserted for this project → KPIs map is empty.

    const outcome = await runDailyTick({
      db,
      ch,
      logger,
      now: () => fixedNow,
    });

    expect(outcome.usersConsidered).toBeGreaterThanOrEqual(1);
    const outboxRows = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.eventType, "revenue.digest.daily"));
    const matching = outboxRows.filter((r) => {
      const p = r.payload as { recipients?: string[] };
      return p.recipients?.includes(istanbulUser);
    });
    expect(matching).toHaveLength(0);
  });

  it("rerunning the same tick is idempotent via eventId", async () => {
    const fixedNow = new Date("2026-05-26T06:00:00Z");
    const istanbulUser = await seedUserWithTimezone("Europe/Istanbul");
    const projectId = await seedProjectMembership(
      istanbulUser,
      `digest-int-${createId()}`,
    );
    await insertRows([
      makeRow({
        projectId,
        subscriberId: createId(),
        type: "INITIAL",
        amountUsd: 50,
        eventDate: "2026-05-25",
      }),
    ]);

    const deps = { db, ch, logger, now: () => fixedNow };
    await runDailyTick(deps);
    await runDailyTick(deps);

    const outboxRows = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.eventType, "revenue.digest.daily"));
    const matching = outboxRows.filter((r) => {
      const p = r.payload as { recipients?: string[]; eventId?: string };
      return p.recipients?.includes(istanbulUser);
    });
    // Outbox itself doesn't dedup on payload.eventId — that's the
    // notifier worker's job — so two outbox rows is expected, both
    // carrying the same eventId. Assert that property instead.
    expect(matching.length).toBeGreaterThanOrEqual(2);
    const eventIds = new Set(
      matching.map((r) => (r.payload as { eventId: string }).eventId),
    );
    expect(eventIds.size).toBe(1);
  });
});
