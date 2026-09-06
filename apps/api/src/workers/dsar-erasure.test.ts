import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// purgeSubscriberFromClickHouseTables — TOTAL vs per-table budget
// =============================================================
//
// Fix Round 2 (ROADMAP §9.1): the ClickHouse purge used to give every
// table its OWN independent `waitForMutation` timeout, so the strict
// worst case scaled with `DSAR_ERASURE_CLICKHOUSE_TABLES.length` (5 x
// 60s = 300000ms, exactly `DSAR_CLAIM_STALE_RUNNING_MS` with zero
// margin). The fix shares ONE deadline across every table's wait. This
// file proves that with a real (fake-timers-driven) run of the actual
// wait loop — not by reading the source and trusting it — using a fake
// ClickHouse client whose `system.mutations` responses are driven by
// poll COUNT, so the assertions are deterministic rather than racing
// real wall-clock ClickHouse behaviour.
//
// `../lib/clickhouse` is mocked because `getClickHouseClient()` throws
// `ClickHouseUnavailableError` unless real ClickHouse env vars are set —
// this suite is testing the TypeScript scheduling logic
// (`purgeSubscriberFromClickHouseTables`'s deadline arithmetic), not
// ClickHouse's own mutation engine, which the real-infra
// `dsar-erasure.integration.test.ts` already covers against ambient
// ClickHouse.

const getClickHouseClientMock = vi.fn();

vi.mock("../lib/clickhouse", () => ({
  getClickHouseClient: (...args: unknown[]) => getClickHouseClientMock(...args),
  isClickHouseConfigured: () => true,
}));

import {
  purgeSubscriberFromClickHouseTables,
  DSAR_ERASURE_CLICKHOUSE_TABLES,
} from "./dsar-erasure";

// DSAR_ERASURE_CLICKHOUSE_TABLES in declaration order:
//   raw_exposures, raw_revenue_events, raw_credit_ledger,
//   raw_sdk_session_events, raw_paywall_events
const [TABLE_1, TABLE_2, TABLE_3, TABLE_4, TABLE_5] = DSAR_ERASURE_CLICKHOUSE_TABLES;

const POLL_INTERVAL_MS = 1_000;

/**
 * A fake ClickHouse client whose `system.mutations` poll for each table
 * reports "done" once that table has been queried `doneAfterPollCount`
 * times. A table absent from `doneAfterPollCount` (or given
 * `Number.POSITIVE_INFINITY`) never reports done — used for the
 * genuinely-stuck table in the discriminating test below.
 */
function createFakeClickHouseClient(doneAfterPollCount: Record<string, number>) {
  const pollCounts: Record<string, number> = {};
  const queriedTables: string[] = [];
  const commandedTables: string[] = [];

  return {
    client: {
      command: vi.fn(async ({ query }: { query: string }) => {
        const table = DSAR_ERASURE_CLICKHOUSE_TABLES.find((t) => query.includes(`.${t} `));
        if (table) commandedTables.push(table);
      }),
      query: vi.fn(async ({ query_params }: { query_params: Record<string, unknown> }) => {
        const table = query_params.table as string;
        queriedTables.push(table);
        pollCounts[table] = (pollCounts[table] ?? 0) + 1;
        const threshold = doneAfterPollCount[table] ?? Number.POSITIVE_INFINITY;
        const isDone = pollCounts[table] >= threshold ? 1 : 0;
        return { json: async () => [{ is_done: isDone, latest_fail_reason: "" }] };
      }),
    },
    queriedTables,
    commandedTables,
    pollCounts,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("purgeSubscriberFromClickHouseTables — shared total budget", () => {
  it("gives up at the TOTAL budget, not a fresh budget per table", async () => {
    // Catches: reverting to a per-table timeout (the pre-fix shape,
    // where `waitForMutation` computed its own `Date.now() + timeoutMs`
    // deadline independently for every table). This test is RED against
    // that shape — see task-4-report.md for the quoted red-check.
    //
    // Each of the first two tables becomes "done" after 2 polls (i.e.
    // one full POLL_INTERVAL_MS sleep); the third never becomes done.
    // With a 2500ms TOTAL budget and a 1000ms poll interval:
    //   - table 1 finishes at virtual t=1000ms
    //   - table 2 finishes at virtual t=2000ms
    //   - table 3's first poll (t=2000ms) is not done; the deadline
    //     (2500ms) has not yet passed, so it sleeps once more; its
    //     second poll (t=3000ms) is still not done, and by then the
    //     shared deadline (2500ms) HAS passed, so it throws at t=3000ms.
    // A per-table implementation would instead give table 3 its OWN
    // fresh 2500ms budget starting at t=2000ms and not give up until
    // t=4500ms — well past the window this test advances through.
    const fake = createFakeClickHouseClient({ [TABLE_1]: 2, [TABLE_2]: 2 });
    getClickHouseClientMock.mockReturnValue(fake.client);

    let settled = false;
    let outcome: "resolved" | "rejected" | undefined;
    let rejection: unknown;
    const promise = purgeSubscriberFromClickHouseTables("sub_budget_test", {
      totalBudgetMs: 2_500,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    promise.then(
      () => {
        settled = true;
        outcome = "resolved";
      },
      (err) => {
        settled = true;
        outcome = "rejected";
        rejection = err;
      },
    );

    // All five DELETEs are submitted up front, before any wait — this
    // must hold regardless of how the wait budget is allocated.
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.commandedTables).toEqual([...DSAR_ERASURE_CLICKHOUSE_TABLES]);

    // Just short of the SHARED deadline (2500ms): table 3's stuck wait
    // must not have given up yet. Under the correct implementation this
    // is true because the deadline hasn't passed; under a per-table
    // implementation it would ALSO still be true (table 3's own budget
    // wouldn't run out until t=4500ms) — this step alone doesn't
    // discriminate, but it establishes nothing fires early.
    await vi.advanceTimersByTimeAsync(2_400);
    expect(settled).toBe(false);

    // Advance past the SHARED deadline (total elapsed now ~3100ms). The
    // fix must have given up here. A per-table implementation would
    // still be waiting (table 3's own 2500ms budget, started fresh at
    // t=2000ms, doesn't expire until t=4500ms) — THIS is the assertion
    // that fails against the per-table behaviour.
    await vi.advanceTimersByTimeAsync(700);
    expect(settled).toBe(true);
    expect(outcome).toBe("rejected");
    expect(String(rejection)).toMatch(/did not finish within/i);
    expect(String(rejection)).toContain(TABLE_3);

    // Execution never reached the tables after the one that exhausted
    // the budget — the wait is sequential per table, not abandoned mid
    // table-list some other way.
    expect(fake.queriedTables).not.toContain(TABLE_4);
    expect(fake.queriedTables).not.toContain(TABLE_5);

    // Tables 1 and 2 genuinely completed (were polled to their done
    // threshold), proving this isn't just "everything times out
    // immediately" — the shared budget was consumed by real waits, not
    // skipped.
    expect(fake.pollCounts[TABLE_1]).toBe(2);
    expect(fake.pollCounts[TABLE_2]).toBe(2);
  });

  it("on exhaustion, never resolves — timeout always surfaces as a rejection", async () => {
    // Catches: a total-budget implementation that swallows the timeout
    // and resolves anyway (a silent COMPLETED upstream in
    // runDsarErasure) instead of always throwing. Every table is
    // permanently stuck here, so ANY resolution would be wrong.
    const fake = createFakeClickHouseClient({});
    getClickHouseClientMock.mockReturnValue(fake.client);

    const promise = purgeSubscriberFromClickHouseTables("sub_never_done", {
      totalBudgetMs: 500,
      pollIntervalMs: 100,
    });
    const assertion = expect(promise).rejects.toThrow(/did not finish within/i);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
  });
});
