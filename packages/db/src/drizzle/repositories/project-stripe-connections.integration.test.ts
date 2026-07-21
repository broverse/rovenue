process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../client";
import { projects, projectStripeConnections } from "../schema";
import * as stripeConnectionRepo from "./project-stripe-connections";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_sc_${RUN_ID}`;

describe("stripeConnectionRepo", () => {
  const projectId = PROJECT_ID;

  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  beforeEach(async () => {
    const db = getDb();
    await db
      .insert(projects)
      .values({ id: PROJECT_ID, name: `SC ${RUN_ID}` })
      .onConflictDoNothing();
    // Each case starts from no connection rows.
    await db
      .delete(projectStripeConnections)
      .where(eq(projectStripeConnections.projectId, PROJECT_ID));
  });

  it("insert then findActiveByProject round-trips", async () => {
    await stripeConnectionRepo.insert(getDb(), {
      projectId,
      stripeAccountId: "acct_live_1",
      livemode: true,
      scope: "read_write",
      chargesEnabled: true,
      payoutsEnabled: true,
      capabilities: { card_payments: "active" },
    });

    const found = await stripeConnectionRepo.findActiveByProject(
      getDb(),
      projectId,
    );
    expect(found?.stripeAccountId).toBe("acct_live_1");
    expect(found?.chargesEnabled).toBe(true);
  });

  it("rejects a second active connection for the same project", async () => {
    await stripeConnectionRepo.insert(getDb(), {
      projectId,
      stripeAccountId: "acct_a",
      livemode: true,
      scope: "read_write",
    });

    await expect(
      stripeConnectionRepo.insert(getDb(), {
        projectId,
        stripeAccountId: "acct_b",
        livemode: true,
        scope: "read_write",
      }),
    ).rejects.toThrow();
  });

  it("allows reconnecting after a disconnect", async () => {
    const first = await stripeConnectionRepo.insert(getDb(), {
      projectId,
      stripeAccountId: "acct_a",
      livemode: true,
      scope: "read_write",
    });
    await stripeConnectionRepo.markDisconnected(
      getDb(),
      first.id,
      "user",
    );

    const second = await stripeConnectionRepo.insert(getDb(), {
      projectId,
      stripeAccountId: "acct_b",
      livemode: true,
      scope: "read_write",
    });
    expect(second.stripeAccountId).toBe("acct_b");

    const active = await stripeConnectionRepo.findActiveByProject(
      getDb(),
      projectId,
    );
    expect(active?.id).toBe(second.id);
  });

  it("findActiveByAccountId ignores disconnected rows", async () => {
    const row = await stripeConnectionRepo.insert(getDb(), {
      projectId,
      stripeAccountId: "acct_gone",
      livemode: true,
      scope: "read_write",
    });
    expect(
      await stripeConnectionRepo.findActiveByAccountId(
        getDb(),
        "acct_gone",
      ),
    ).not.toBeNull();

    await stripeConnectionRepo.markDisconnected(
      getDb(),
      row.id,
      "stripe_deauthorized",
    );
    expect(
      await stripeConnectionRepo.findActiveByAccountId(
        getDb(),
        "acct_gone",
      ),
    ).toBeNull();
  });

  it("updateAccountState overwrites capability fields", async () => {
    const row = await stripeConnectionRepo.insert(getDb(), {
      projectId,
      stripeAccountId: "acct_c",
      livemode: true,
      scope: "read_write",
      chargesEnabled: false,
    });

    await stripeConnectionRepo.updateAccountState(getDb(), row.id, {
      chargesEnabled: true,
      payoutsEnabled: true,
      capabilities: { card_payments: "active" },
      country: "TR",
      defaultCurrency: "try",
    });

    const found = await stripeConnectionRepo.findActiveByProject(
      getDb(),
      projectId,
    );
    expect(found?.chargesEnabled).toBe(true);
    expect(found?.country).toBe("TR");
    expect(found?.lastSyncedAt).not.toBeNull();
  });
});
