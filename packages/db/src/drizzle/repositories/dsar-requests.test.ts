import { describe, expect, it } from "vitest";
import {
  DSAR_CLAIM_STALE_RUNNING_MARGIN_MS,
  DSAR_CLAIM_STALE_RUNNING_MS,
  DSAR_ERASURE_CLICKHOUSE_PURGE_TOTAL_BUDGET_MS,
} from "./dsar-requests";

// =============================================================
// DSAR claim-staleness constants — Fix Round 2
// =============================================================
//
// No DB needed: this pins the ARITHMETIC relationship between the
// ClickHouse purge's total wait budget and the stale-RUNNING reclaim
// threshold, so the two constants cannot silently drift apart again the
// way the original (per-table) version did — see dsar-requests.ts's
// module doc above `claimDsarRequest` for the full history.

describe("DSAR claim-staleness constants", () => {
  it("derives DSAR_CLAIM_STALE_RUNNING_MS as the purge budget PLUS a stated margin", () => {
    // Catches: reverting the threshold back to an independent, re-typed
    // literal (e.g. hardcoding `300_000` again) instead of a sum of the
    // two named constants — the exact regression this file's own history
    // already had once. A literal that happens to still equal the sum
    // today would pass a value-only assertion; expressing it as an
    // addition here means any future edit to either input constant is
    // reflected here without this test itself needing to change.
    expect(DSAR_CLAIM_STALE_RUNNING_MS).toBe(
      DSAR_ERASURE_CLICKHOUSE_PURGE_TOTAL_BUDGET_MS + DSAR_CLAIM_STALE_RUNNING_MARGIN_MS,
    );
  });

  it("pins the actual numbers so a silent change to either is visible in a diff", () => {
    // Catches: someone quietly shrinking the purge budget or the margin
    // (e.g. to "fix" a flaky test) without revisiting the worst-case
    // argument in the module doc — this test forces that edit to show up
    // as an intentional, reviewable diff instead of passing silently.
    expect(DSAR_ERASURE_CLICKHOUSE_PURGE_TOTAL_BUDGET_MS).toBe(90_000);
    expect(DSAR_CLAIM_STALE_RUNNING_MARGIN_MS).toBe(150_000);
    expect(DSAR_CLAIM_STALE_RUNNING_MS).toBe(240_000);
  });

  it("keeps the stale threshold below the DSAR queues' cumulative BullMQ backoff window", () => {
    // Catches: the margin growing so large that a genuinely wedged
    // RUNNING row (the double-fault case claimDsarRequest exists to
    // recover from) would never be reclaimed before BullMQ exhausts its
    // own retry attempts — see apps/api/src/queues/dsar.ts's
    // DSAR_JOB_ATTEMPTS/DSAR_JOB_BACKOFF_MS (30s+60s+120s+240s = 450s).
    // apps/api owns that constant and packages/db cannot import it back
    // (the dependency runs the other way), so the 450s figure is
    // reproduced here as a literal — the two are cross-checked by the
    // comment in both files rather than a shared import.
    const DSAR_CUMULATIVE_BACKOFF_WINDOW_MS = 450_000;
    expect(DSAR_CLAIM_STALE_RUNNING_MS).toBeLessThan(DSAR_CUMULATIVE_BACKOFF_WINDOW_MS);
  });

  it("gives the stale threshold real margin above the purge budget alone", () => {
    // Catches: a margin so thin it reproduces the original bug's "zero
    // margin at the worst case" shape even though it is now expressed as
    // a sum — e.g. a margin of a few hundred ms would technically be
    // "derived" but would not actually protect a healthy-but-slow run.
    const marginRatio = DSAR_CLAIM_STALE_RUNNING_MS / DSAR_ERASURE_CLICKHOUSE_PURGE_TOTAL_BUDGET_MS;
    expect(marginRatio).toBeGreaterThan(1.5);
  });
});
