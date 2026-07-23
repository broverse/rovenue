// =============================================================
// upsertPending — fencing token guard
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../client";
import { funnelPurchases, projects } from "../schema";
import { upsertPending } from "./funnel-purchases";

const RUN_ID = Date.now();
const P = `prj_fence_${RUN_ID}`;
const SESSION = `sess_fence_${RUN_ID}`;

afterAll(async () => {
  const db = getDb();
  await db.delete(funnelPurchases).where(eq(funnelPurchases.sessionId, SESSION));
  await db.delete(projects).where(eq(projects.id, P));
});

describe("upsertPending — fencing token", () => {
  it("accepts a strictly greater token and rejects a stale one", async () => {
    const db = getDb();
    await db.insert(projects).values({ id: P, name: "fence-test-project" });

    // First attempt: no row yet, so the INSERT path runs (no conflict,
    // guard does not apply).
    const first = await upsertPending(db, {
      sessionId: SESSION,
      projectId: P,
      stripePaymentIntentId: "pi_first",
      fenceToken: 1,
    });
    expect(first).not.toBeNull();
    expect(first?.fenceToken).toBe(1);

    // A newer holder read 1 and writes 2 — strictly greater, accepted.
    const newer = await upsertPending(db, {
      sessionId: SESSION,
      projectId: P,
      stripePaymentIntentId: "pi_newer",
      fenceToken: 2,
    });
    expect(newer).not.toBeNull();
    expect(newer?.stripePaymentIntentId).toBe("pi_newer");

    // A stale holder that also read 1 now tries to write 2. `2 < 2` is
    // false, so SQL refuses it and nothing is returned.
    const stale = await upsertPending(db, {
      sessionId: SESSION,
      projectId: P,
      stripePaymentIntentId: "pi_stale",
      fenceToken: 2,
    });
    expect(stale).toBeNull();

    // The newer holder's row must be untouched.
    const [row] = await db
      .select()
      .from(funnelPurchases)
      .where(eq(funnelPurchases.sessionId, SESSION));
    expect(row?.stripePaymentIntentId).toBe("pi_newer");
    expect(row?.fenceToken).toBe(2);
  });
});
