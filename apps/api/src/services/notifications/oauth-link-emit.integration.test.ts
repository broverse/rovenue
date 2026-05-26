// =============================================================
// maybeEmitOAuthLink — integration tests
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import { drizzle, getDb } from "@rovenue/db";
import {
  FRESH_ACCOUNT_WINDOW_MS,
  maybeEmitOAuthLink,
} from "./oauth-link-emit";

const RUN_ID = Date.now();
const db = getDb();
const schema = drizzle.schema;

async function seedUser(suffix: string) {
  const id = `usr_oauth_${RUN_ID}_${suffix}`;
  const now = new Date();
  await db.insert(schema.user).values({
    id,
    name: `o-${suffix}`,
    email: `${id}@example.test`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function seedAccount(opts: {
  userId: string;
  providerId: string;
  createdAt?: Date;
}) {
  const now = opts.createdAt ?? new Date();
  await db.insert(schema.account).values({
    id: createId(),
    accountId: createId(),
    providerId: opts.providerId,
    userId: opts.userId,
    createdAt: now,
    updatedAt: now,
  });
}

const seededUserIds: string[] = [];
function track(id: string): string {
  seededUserIds.push(id);
  return id;
}

afterAll(async () => {
  for (const id of seededUserIds) {
    await db.delete(schema.user).where(eq(schema.user.id, id));
  }
});

async function matchingOutbox(userId: string) {
  const rows = await db
    .select()
    .from(schema.outboxEvents)
    .where(
      eq(schema.outboxEvents.eventType, "security.oauth.account_linked"),
    );
  return rows.filter((r) => {
    const p = r.payload as { recipients?: string[] };
    return p.recipients?.includes(userId);
  });
}

describe.sequential("maybeEmitOAuthLink", () => {
  it("first-account user (signup, not link) → no emit", async () => {
    const userId = track(await seedUser("signup"));
    await seedAccount({ userId, providerId: "github" });

    const out = await maybeEmitOAuthLink(db, { userId });
    expect(out).toBeNull();
    expect(await matchingOutbox(userId)).toHaveLength(0);
  });

  it("fresh second-account → emits with the newest provider", async () => {
    const userId = track(await seedUser("link"));
    // Pre-existing github account (link target user).
    await seedAccount({
      userId,
      providerId: "github",
      createdAt: new Date(Date.now() - 30_000),
    });
    // Just-linked google account.
    await seedAccount({ userId, providerId: "google" });

    const out = await maybeEmitOAuthLink(db, { userId });
    expect(out?.provider).toBe("google");

    const matches = await matchingOutbox(userId);
    expect(matches).toHaveLength(1);
    const payload = matches[0]!.payload as {
      context: { provider: string; whenIso: string };
    };
    expect(payload.context.provider).toBe("google");
    expect(payload.context.whenIso).toBeDefined();
  });

  it("stale newest account (outside the 10s window) → no emit", async () => {
    const userId = track(await seedUser("stale"));
    await seedAccount({
      userId,
      providerId: "github",
      createdAt: new Date(Date.now() - 60_000),
    });
    await seedAccount({
      userId,
      providerId: "google",
      createdAt: new Date(Date.now() - FRESH_ACCOUNT_WINDOW_MS - 5_000),
    });

    const out = await maybeEmitOAuthLink(db, { userId });
    expect(out).toBeNull();
    expect(await matchingOutbox(userId)).toHaveLength(0);
  });

  it("unknown provider → no emit (catalog enum is github|google only)", async () => {
    const userId = track(await seedUser("unknown"));
    await seedAccount({
      userId,
      providerId: "github",
      createdAt: new Date(Date.now() - 30_000),
    });
    await seedAccount({ userId, providerId: "credential" });

    const out = await maybeEmitOAuthLink(db, { userId });
    expect(out).toBeNull();
    expect(await matchingOutbox(userId)).toHaveLength(0);
  });

  it("dedup: same provider linked the same day → second call's eventId matches", async () => {
    const userId = track(await seedUser("dedup"));
    await seedAccount({
      userId,
      providerId: "github",
      createdAt: new Date(Date.now() - 30_000),
    });
    await seedAccount({ userId, providerId: "google" });

    await maybeEmitOAuthLink(db, { userId });
    // Simulate a second callback firing for the same link op.
    await maybeEmitOAuthLink(db, { userId });

    const matches = await matchingOutbox(userId);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    const eventIds = new Set(
      matches.map((r) => (r.payload as { eventId: string }).eventId),
    );
    expect(eventIds.size).toBe(1);
  });
});
