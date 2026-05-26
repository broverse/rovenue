// =============================================================
// emitNotification — integration tests (real Postgres)
// =============================================================

import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { getDb, drizzle as drizzleNs } from "@rovenue/db";
import { emitNotification } from "./emit";

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

const schema = drizzleNs.schema;
const db = getDb();

async function findOutboxByEventId(eventId: string) {
  return db
    .select()
    .from(schema.outboxEvents)
    .where(sql`${schema.outboxEvents.payload}->>'eventId' = ${eventId}`);
}

describe("emitNotification", () => {
  it("writes an outbox row in the caller's tx", async () => {
    const eventId = `signin:${createId()}`;
    await db.transaction(async (tx) => {
      await emitNotification(tx, {
        eventKey: "security.signin.new_device",
        eventId,
        recipients: ["user-1"],
        context: {
          userAgent: "Chrome",
          ipAddress: "1.2.3.4",
          whenIso: "2026-05-26T10:00:00Z",
        },
      });
    });

    const rows = await findOutboxByEventId(eventId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.aggregateType).toBe("NOTIFICATION");
    expect(row.aggregateId).toBe("account");
    expect(row.eventType).toBe("security.signin.new_device");
    expect(row.payload).toMatchObject({
      eventKey: "security.signin.new_device",
      eventId,
      recipients: ["user-1"],
      context: {
        userAgent: "Chrome",
        ipAddress: "1.2.3.4",
        whenIso: "2026-05-26T10:00:00Z",
      },
    });
  });

  it("uses projectId as aggregateId when provided", async () => {
    const eventId = `webhook:${createId()}`;
    const projectId = createId();
    await db.transaction(async (tx) => {
      await emitNotification(tx, {
        eventKey: "integration.webhook.failing",
        eventId,
        projectId,
        context: {
          projectId,
          projectName: "Test Project",
          webhookId: createId(),
          endpointUrl: "https://example.com/hook",
          consecutiveFailures: 5,
        },
      });
    });

    const rows = await findOutboxByEventId(eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.aggregateId).toBe(projectId);
  });

  it("rolls back if the caller's tx rolls back", async () => {
    const eventId = `rollback:${createId()}`;
    await expect(
      db.transaction(async (tx) => {
        await emitNotification(tx, {
          eventKey: "security.signin.new_device",
          eventId,
          recipients: ["user-1"],
          context: {
            userAgent: "Chrome",
            ipAddress: "1.2.3.4",
            whenIso: "2026-05-26T10:00:00Z",
          },
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    const rows = await findOutboxByEventId(eventId);
    expect(rows).toHaveLength(0);
  });

  it("rejects context that fails the event's schema", async () => {
    await expect(
      db.transaction(async (tx) => {
        await emitNotification(tx, {
          eventKey: "security.signin.new_device",
          eventId: `bad:${createId()}`,
          recipients: ["u"],
          context: { userAgent: 42 } as never,
        });
      }),
    ).rejects.toThrow(/invalid context/i);
  });

  it("rejects an unknown event key", async () => {
    await expect(
      db.transaction(async (tx) => {
        await emitNotification(tx, {
          eventKey: "totally.fake.event",
          eventId: createId(),
          context: {},
        });
      }),
    ).rejects.toThrow(/unknown event/i);
  });
});
