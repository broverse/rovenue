import { describe, expect, it } from "vitest";
import {
  correctNewestEntryWatermark,
  type Journal,
  type JournalEntry,
} from "../scripts/fix-journal-watermark";

// =============================================================
// Generation-time watermark correction
// =============================================================
//
// packages/db/tests/journal-monotonic.test.ts catches an unreachable
// migration AFTER it lands in the journal file -- a backstop that only helps
// if someone runs it before pushing. This test exercises the correction
// function that packages/db's `db:migrate:generate` script now runs
// immediately after `drizzle-kit generate`, so a too-low `when` never
// reaches a commit in the first place. See scripts/fix-journal-watermark.ts.

const SYNTHETIC_DAY_STEP_MS = 86_400_000;

function entry(idx: number, when: number, tag = `${String(idx).padStart(4, "0")}_fixture`): JournalEntry {
  return { idx, version: "7", when, tag, breakpoints: true };
}

function journal(entries: JournalEntry[]): Journal {
  return { version: "7", dialect: "postgresql", entries };
}

describe("correctNewestEntryWatermark", () => {
  it("raises a newest entry that lands at or below the prior maximum", () => {
    // Reproduces the 0121-0129 shape: earlier entries were hand-set to a
    // synthetic future cadence, and `drizzle-kit generate` timestamps the
    // new entry from real wall clock, landing underneath.
    const priorMax = 1_789_339_200_000; // matches the real journal's current max
    const j = journal([
      entry(0, 1_700_000_000_000),
      entry(129, priorMax, "0129_freezing_corsair"),
      entry(130, 1_700_500_000_000, "0130_new_migration"), // real wall clock, below priorMax
    ]);

    const result = correctNewestEntryWatermark(j);

    expect(result.corrected).toBe(true);
    expect(result.priorMax).toBe(priorMax);
    expect(result.originalWhen).toBe(1_700_500_000_000);
    expect(result.correctedWhen).toBe(priorMax + SYNTHETIC_DAY_STEP_MS);
    // The mutation lands on the actual journal object, ready to serialize.
    expect(j.entries[2]!.when).toBe(priorMax + SYNTHETIC_DAY_STEP_MS);
    expect(j.entries[2]!.when).toBeGreaterThan(priorMax);
  });

  it("treats an equal `when` as needing correction, mirroring drizzle's strict `<`", () => {
    const priorMax = 1_789_339_200_000;
    const j = journal([
      entry(0, priorMax, "0000_fixture"),
      entry(1, priorMax, "0001_new"),
    ]);

    const result = correctNewestEntryWatermark(j);

    expect(result.corrected).toBe(true);
    expect(result.correctedWhen).toBe(priorMax + SYNTHETIC_DAY_STEP_MS);
  });

  it("does nothing when the newest entry is already strictly above the maximum", () => {
    const j = journal([
      entry(0, 1_000),
      entry(1, 2_000),
      entry(2, 3_000),
    ]);

    const result = correctNewestEntryWatermark(j);

    expect(result.corrected).toBe(false);
    expect(result.correctedWhen).toBeUndefined();
    expect(j.entries[2]!.when).toBe(3_000);
  });

  it("does nothing to a single-entry journal", () => {
    const j = journal([entry(0, 42)]);

    const result = correctNewestEntryWatermark(j);

    expect(result.corrected).toBe(false);
    expect(j.entries[0]!.when).toBe(42);
  });

  it("blames the running maximum across all prior entries, not just the immediate predecessor", () => {
    // Mirrors the 0053/0054/0055 shape from journal-monotonic.test.ts: an
    // earlier entry (idx 0) towers over the one directly before the newest.
    const towering = 5_000_000;
    const j = journal([
      entry(0, towering),
      entry(1, 1_000),
      entry(2, 1_500), // above idx 1, but still below idx 0's towering value
    ]);

    const result = correctNewestEntryWatermark(j);

    expect(result.corrected).toBe(true);
    expect(result.priorMax).toBe(towering);
    expect(result.correctedWhen).toBe(towering + SYNTHETIC_DAY_STEP_MS);
  });

  it("never rewrites any entry other than the newest", () => {
    const j = journal([
      entry(0, 5_000_000, "0000_towering"),
      entry(1, 1_000, "0001_untouched"),
      entry(2, 1_500, "0002_newest"),
    ]);

    correctNewestEntryWatermark(j);

    expect(j.entries[0]!.when).toBe(5_000_000);
    expect(j.entries[1]!.when).toBe(1_000);
  });

  it("names the corrected entry's tag and idx on the result, for the caller's log line", () => {
    const j = journal([
      entry(0, 5_000_000, "0000_towering"),
      entry(1, 1_000, "0001_new_migration"),
    ]);

    const result = correctNewestEntryWatermark(j);

    expect(result.entry.tag).toBe("0001_new_migration");
    expect(result.entry.idx).toBe(1);
  });
});
