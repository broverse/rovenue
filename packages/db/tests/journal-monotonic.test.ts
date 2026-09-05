import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

// =============================================================
// Journal watermark-monotonicity guard
// =============================================================
//
// drizzle-orm's migrator does NOT track which migrations ran. It reads the
// single highest `created_at` already recorded in the target database:
//
//   select id, hash, created_at from drizzle.__drizzle_migrations
//     order by created_at desc limit 1
//
// and then applies a journal entry only when
//
//   Number(lastDbMigration.created_at) < migration.folderMillis
//
// (drizzle-orm 0.45.2, pg-core/dialect.js). `folderMillis` is the entry's
// `when` in meta/_journal.json, and it is also the value written back as
// `created_at`. So the bookkeeping table holds a WATERMARK, not a set.
//
// The consequence: if any entry's `when` is not strictly greater than every
// `when` before it, that entry is unreachable. A database whose watermark is
// the higher earlier entry considers it already applied and skips it —
// silently, forever. No error, no retry; the schema is simply missing whatever
// that migration created, and the failure surfaces much later as a runtime
// "column does not exist".
//
// This has already happened five times in this journal (see the frozen table
// below) and nearly happened a sixth time in 0124: drizzle-kit stamped the new
// entry with a real wall-clock timestamp that landed BELOW the hand-set,
// deliberately-future `when` of its predecessor, and only an implementer
// noticing by eye stopped it. Hand-set round timestamps are the recurring
// cause — they are chosen to sit above whatever is present, and every
// generated entry that follows then lands underneath them.
//
// This guard turns that from luck into a build failure.
//
// Why the five historical violations are frozen rather than fixed
// ---------------------------------------------------------------
// They cannot be repaired by editing the journal, in either direction:
//
//   * RAISING an out-of-order entry risks RE-APPLYING it. The watermark is not
//     injective: watermark 1780000003000 is produced both by a database that
//     stopped at 0040 (which has NOT run 0041) and by one that installed when
//     the journal ended at 0041 (which HAS). Any value that makes 0041 pending
//     for the first re-runs it on the second, and 0041 opens with a bare
//     `CREATE TYPE` — the migration would fail outright.
//
//   * LOWERING the blocking predecessor cannot reach monotonicity. Each
//     minimal repair interval is empty — 0040 would have to drop below
//     0041's 1779813463236 while staying above 0039's 1780000000000. Cascading
//     the lower bound backwards does close the ordering, but it drags 17
//     further entries under reachable watermarks, converting 5 silently-skipped
//     migrations into 22.
//
// And no journal edit rescues a database that is ALREADY past one of these
// points: its watermark was recorded at apply time and lives in its own
// `__drizzle_migrations` table. The file cannot rewrite that history.
//
// So the five below are permanent scar tissue. They are pinned by exact value
// so that a renumber, a regeneration, or a well-meant "fix" re-arms the guard
// instead of quietly widening the exemption.

const JOURNAL_PATH = new URL(
  "../drizzle/migrations/meta/_journal.json",
  import.meta.url,
);

/** Journal entries are appended, never reordered, so a healthy journal has at
 *  least this many. Purely a sanity floor against reading a truncated file. */
const MINIMUM_PLAUSIBLE_ENTRY_COUNT = 50;

type JournalEntry = { idx: number; tag: string; when: number };

/** One entry that drizzle's watermark can never reach, and the earlier entry
 *  whose `when` shadows it. */
type WatermarkSkip = {
  idx: number;
  tag: string;
  when: number;
  blockedByIdx: number;
  blockedByTag: string;
  blockedByWhen: number;
};

/**
 * Every entry that drizzle's migrator would skip forever.
 *
 * The comparison is against the RUNNING MAXIMUM of all preceding `when`
 * values, not against the immediate predecessor. That distinction is
 * load-bearing: 0054 and 0055 each sit above the entry directly before them
 * and are still unreachable, because 0052's hand-set value towers over the
 * whole run. A pairwise check would report 3 violations and miss 2.
 */
function findWatermarkSkips(entries: readonly JournalEntry[]): WatermarkSkip[] {
  const ordered = [...entries].sort((a, b) => a.idx - b.idx);
  const skips: WatermarkSkip[] = [];
  let highest: JournalEntry | undefined;

  for (const entry of ordered) {
    // `<` is drizzle's own operator: an entry whose `when` merely EQUALS the
    // watermark is skipped too, so equality is a violation, not a tie.
    if (highest !== undefined && entry.when <= highest.when) {
      skips.push({
        idx: entry.idx,
        tag: entry.tag,
        when: entry.when,
        blockedByIdx: highest.idx,
        blockedByTag: highest.tag,
        blockedByWhen: highest.when,
      });
      continue;
    }
    highest = entry;
  }

  return skips;
}

function describeSkip(skip: WatermarkSkip): string {
  return (
    `idx ${skip.idx} (${skip.tag}) when=${skip.when} is unreachable: ` +
    `idx ${skip.blockedByIdx} (${skip.blockedByTag}) already sets the ` +
    `watermark to ${skip.blockedByWhen}. drizzle applies an entry only when ` +
    `max(created_at) < its "when", so idx ${skip.idx} is skipped forever on ` +
    `any database that has reached idx ${skip.blockedByIdx}. Raise idx ` +
    `${skip.idx}'s "when" above ${skip.blockedByWhen} BEFORE this migration ` +
    `ships anywhere — once a database has recorded the higher watermark, no ` +
    `journal edit can repair it.`
  );
}

/**
 * The five pre-existing violations, pinned by exact value.
 *
 * Do not add to this table. A new row here means a migration that will never
 * run on an existing database — the fix is to raise the new entry's `when`,
 * which is free and safe while the migration is still unreleased.
 */
const FROZEN_LEGACY_SKIPS: readonly WatermarkSkip[] = [
  {
    idx: 41,
    tag: "0041_empty_scarlet_spider",
    when: 1779813463236,
    blockedByIdx: 40,
    blockedByTag: "0040_project_invitations",
    blockedByWhen: 1780000003000,
  },
  {
    idx: 53,
    tag: "0053_bored_multiple_man",
    when: 1779921368923,
    blockedByIdx: 52,
    blockedByTag: "0052_aggregate_type_funnel",
    blockedByWhen: 1780000160000,
  },
  {
    idx: 54,
    tag: "0054_access_foundation",
    when: 1779921611710,
    blockedByIdx: 52,
    blockedByTag: "0052_aggregate_type_funnel",
    blockedByWhen: 1780000160000,
  },
  {
    idx: 55,
    tag: "0055_subscriber_access_accessid",
    when: 1779922466662,
    blockedByIdx: 52,
    blockedByTag: "0052_aggregate_type_funnel",
    blockedByWhen: 1780000160000,
  },
  {
    idx: 59,
    tag: "0059_brainy_prodigy",
    when: 1779979092849,
    blockedByIdx: 58,
    blockedByTag: "0058_experiment_type_offering",
    blockedByWhen: 1780000220000,
  },
];

function loadJournalEntries(): JournalEntry[] {
  const raw = readFileSync(JOURNAL_PATH, "utf8");
  const parsed = JSON.parse(raw) as { entries: JournalEntry[] };
  return parsed.entries;
}

describe("migration journal watermark monotonicity", () => {
  const entries = loadJournalEntries();

  it("the journal is readable and non-trivial", () => {
    expect(existsSync(JOURNAL_PATH)).toBe(true);
    expect(entries.length).toBeGreaterThan(MINIMUM_PLAUSIBLE_ENTRY_COUNT);
  });

  it("idx matches array position, so ordering by idx is ordering as written", () => {
    // findWatermarkSkips sorts by idx. If idx ever diverged from file order,
    // the guard would be checking a different sequence than drizzle-kit reads.
    const misplaced = entries
      .map((entry, position) => ({ entry, position }))
      .filter(({ entry, position }) => entry.idx !== position)
      .map(({ entry, position }) => `${entry.tag} has idx ${entry.idx} at position ${position}`);
    expect(misplaced, misplaced.join("; ")).toEqual([]);
  });

  it("no entry beyond the frozen legacy five is unreachable to the watermark", () => {
    const frozenIdx = new Set(FROZEN_LEGACY_SKIPS.map((s) => s.idx));
    const unexpected = findWatermarkSkips(entries).filter(
      (skip) => !frozenIdx.has(skip.idx),
    );
    expect(unexpected.map(describeSkip), unexpected.map(describeSkip).join("\n")).toEqual([]);
  });

  it("each frozen legacy skip still matches the journal exactly", () => {
    // Pinning the values means a renumber or a partial "fix" re-arms the
    // guard rather than silently keeping a stale exemption alive.
    const actual = findWatermarkSkips(entries).filter((skip) =>
      FROZEN_LEGACY_SKIPS.some((frozen) => frozen.idx === skip.idx),
    );
    expect(actual).toEqual([...FROZEN_LEGACY_SKIPS]);
  });

  it("the frozen list has no stale rows", () => {
    // If a violation is ever genuinely repaired, this fails and tells the
    // author to delete the row — the exemption must not outlive its cause.
    const liveIdx = new Set(findWatermarkSkips(entries).map((s) => s.idx));
    const stale = FROZEN_LEGACY_SKIPS.filter((frozen) => !liveIdx.has(frozen.idx));
    expect(
      stale.map((s) => s.tag),
      `no longer out of order — remove from FROZEN_LEGACY_SKIPS: ${stale
        .map((s) => s.tag)
        .join(", ")}`,
    ).toEqual([]);
  });
});

// -------------------------------------------------------------
// Detector behaviour, on synthetic journals
// -------------------------------------------------------------
//
// The assertions above are only as good as findWatermarkSkips. These pin its
// behaviour against shapes the real journal does not currently contain —
// including the exact 0124 near-miss that motivated this guard.

const BASE_WHEN = 1_700_000_000_000;

function entry(idx: number, when: number): JournalEntry {
  return { idx, tag: `${String(idx).padStart(4, "0")}_fixture`, when };
}

describe("findWatermarkSkips", () => {
  it("reports nothing for a strictly increasing journal", () => {
    const journal = [
      entry(0, BASE_WHEN),
      entry(1, BASE_WHEN + 1),
      entry(2, BASE_WHEN + 2),
    ];
    expect(findWatermarkSkips(journal)).toEqual([]);
  });

  it("catches the 0124 shape: a generated entry landing under a hand-set predecessor", () => {
    const handSetFuture = BASE_WHEN + 10_000;
    const generatedBelow = BASE_WHEN + 5_000;
    const journal = [
      entry(122, BASE_WHEN),
      entry(123, handSetFuture),
      entry(124, generatedBelow),
    ];
    const skips = findWatermarkSkips(journal);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({ idx: 124, blockedByIdx: 123 });
  });

  it("treats an equal timestamp as a violation, because drizzle compares with <", () => {
    const journal = [entry(0, BASE_WHEN), entry(1, BASE_WHEN)];
    const skips = findWatermarkSkips(journal);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({ idx: 1, blockedByIdx: 0 });
  });

  it("blames the running maximum, not the immediate predecessor", () => {
    // The 0053/0054/0055 shape: 54 sits above 53 yet is still unreachable,
    // because 52's value shadows the whole run. A pairwise check misses it.
    const towering = BASE_WHEN + 100_000;
    const journal = [
      entry(52, towering),
      entry(53, BASE_WHEN + 10),
      entry(54, BASE_WHEN + 20),
    ];
    const skips = findWatermarkSkips(journal);
    expect(skips.map((s) => s.idx)).toEqual([53, 54]);
    expect(skips.every((s) => s.blockedByIdx === 52)).toBe(true);
  });

  it("names both the offending entry and its blocker in the failure message", () => {
    const journal = [entry(7, BASE_WHEN + 900), entry(8, BASE_WHEN)];
    const [skip] = findWatermarkSkips(journal);
    expect(skip).toBeDefined();
    const message = describeSkip(skip!);
    expect(message).toContain("idx 8");
    expect(message).toContain("0008_fixture");
    expect(message).toContain("idx 7");
    expect(message).toContain("0007_fixture");
  });
});
