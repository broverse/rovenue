// =============================================================
// digest-kpi — integration tests against the dev-stack ClickHouse
// =============================================================
//
// Inserts directly into rovenue.raw_revenue_events using a
// per-test unique projectId so the assertions are isolated
// regardless of what else is sitting in the shared CH instance.
// No cleanup needed — the table has a 2-year TTL and the test
// rows are scoped to project ids the rest of the suite never
// touches.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import {
  createClient,
  type ClickHouseClient,
} from "@clickhouse/client";
import {
  fetchDailyKPIs,
  hasActivity,
  type DigestSection,
} from "./digest-kpi";

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
  eventDate: string; // ISO date or YYYY-MM-DD
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
    eventDate:
      input.eventDate.length === 10
        ? `${input.eventDate} 12:00:00.000`
        : input.eventDate,
    ingestedAt: now,
    _version: 1,
  };
}

describe.sequential("fetchDailyKPIs (integration)", () => {
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

  it("returns empty when no project ids", async () => {
    const out = await fetchDailyKPIs(ch, [], "2026-05-26");
    expect(out.size).toBe(0);
  });

  it("returns empty when ch is null", async () => {
    const out = await fetchDailyKPIs(null, ["any"], "2026-05-26");
    expect(out.size).toBe(0);
  });

  it("aggregates a full day across event types + computes delta", async () => {
    const projectId = `digest-kpi-${createId()}`;
    const sub1 = createId();
    const sub2 = createId();
    const sub3 = createId();

    // Prior day: $50 net.
    // Target day: 2 INITIAL ($30 + $20 = $50), 1 RENEWAL ($10),
    //             1 CANCELLATION ($0 by convention), 1 REFUND -$5.
    // Net target = 30 + 20 + 10 = $60. Delta = $60 - $50 = +$10.
    await insertRows([
      makeRow({
        projectId,
        subscriberId: sub1,
        type: "RENEWAL",
        amountUsd: 50,
        eventDate: "2026-05-25",
      }),
      makeRow({
        projectId,
        subscriberId: sub1,
        type: "INITIAL",
        amountUsd: 30,
        eventDate: "2026-05-26",
      }),
      makeRow({
        projectId,
        subscriberId: sub2,
        type: "INITIAL",
        amountUsd: 20,
        eventDate: "2026-05-26",
      }),
      makeRow({
        projectId,
        subscriberId: sub1,
        type: "RENEWAL",
        amountUsd: 10,
        eventDate: "2026-05-26",
      }),
      makeRow({
        projectId,
        subscriberId: sub3,
        type: "CANCELLATION",
        amountUsd: 0,
        eventDate: "2026-05-26",
      }),
      makeRow({
        projectId,
        subscriberId: sub2,
        type: "REFUND",
        amountUsd: 5,
        eventDate: "2026-05-26",
      }),
    ]);

    const out = await fetchDailyKPIs(ch, [projectId], "2026-05-26");
    const section = out.get(projectId);
    expect(section).toBeDefined();
    const s = section as DigestSection;
    expect(s.netCents).toBe(60_00);
    expect(s.netDeltaCents).toBe(10_00);
    expect(s.newSubs).toBe(2);
    expect(s.churnedSubs).toBe(1);
    expect(s.refundCount).toBe(1);
    expect(s.refundTotalCents).toBe(5_00);
    expect(hasActivity(s)).toBe(true);
  });

  it("isolates by projectId — unrelated projects don't bleed in", async () => {
    const projectA = `digest-kpi-${createId()}`;
    const projectB = `digest-kpi-${createId()}`;
    await insertRows([
      makeRow({
        projectId: projectA,
        subscriberId: createId(),
        type: "INITIAL",
        amountUsd: 99,
        eventDate: "2026-05-26",
      }),
      makeRow({
        projectId: projectB,
        subscriberId: createId(),
        type: "INITIAL",
        amountUsd: 11,
        eventDate: "2026-05-26",
      }),
    ]);

    const out = await fetchDailyKPIs(ch, [projectA], "2026-05-26");
    expect(out.size).toBe(1);
    expect(out.get(projectA)?.netCents).toBe(99_00);
    expect(out.has(projectB)).toBe(false);
  });

  it("omits projects with zero activity in the [date-1, date] window", async () => {
    const projectId = `digest-kpi-${createId()}`;
    // Event two days before the target → outside the window.
    await insertRows([
      makeRow({
        projectId,
        subscriberId: createId(),
        type: "INITIAL",
        amountUsd: 100,
        eventDate: "2026-05-24",
      }),
    ]);

    const out = await fetchDailyKPIs(ch, [projectId], "2026-05-26");
    expect(out.has(projectId)).toBe(false);
  });

  it("hasActivity flags zero-activity sections", () => {
    const s: DigestSection = {
      projectId: "p",
      netCents: 0,
      netDeltaCents: 0,
      newSubs: 0,
      churnedSubs: 0,
      refundCount: 0,
      refundTotalCents: 0,
    };
    expect(hasActivity(s)).toBe(false);
    expect(hasActivity({ ...s, newSubs: 1 })).toBe(true);
    expect(hasActivity({ ...s, netDeltaCents: -100 })).toBe(true);
  });
});
