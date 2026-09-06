import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// =============================================================
// Post-generation journal watermark correction
// =============================================================
//
// drizzle-orm's migrator does not track which migrations ran; it reads the
// single highest `created_at` already recorded in the target database and
// applies a journal entry only when that watermark is strictly below the
// entry's `when` (see packages/db/tests/journal-monotonic.test.ts for the
// full mechanics and history).
//
// Several migrations in this journal (0121-0129) were hand-set to a
// synthetic future `+86400000`/day cadence rather than real wall-clock
// values. That pushed the watermark days ahead of wall clock, so every
// migration `drizzle-kit generate` produces afterwards — timestamped from
// real time — lands BELOW it and would be silently skipped forever on any
// upgrade-path database. This hit migrations 0125 and 0126 independently and
// was only caught because someone happened to run the guard test by hand.
//
// This script is the fix at the source: it runs immediately after
// `drizzle-kit generate` (see packages/db package.json's `db:migrate:generate`)
// and corrects the newly appended entry's `when` if needed, so a bad value
// never reaches a commit in the first place. The vitest guard in
// journal-monotonic.test.ts remains as the backstop for anything that
// bypasses this script (hand-edited journals, older clones, etc).

/** Amount added above the existing maximum when a correction is needed.
 * Matches the day-cadence convention already present in the synthetic
 * 0121-0129 timestamps, so a corrected value reads consistently with its
 * neighbours instead of looking like an arbitrary patch. */
const SYNTHETIC_DAY_STEP_MS = 86_400_000;

const JOURNAL_PATH = new URL(
  "../drizzle/migrations/meta/_journal.json",
  import.meta.url,
);

export type JournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

export type Journal = {
  version: string;
  dialect: string;
  entries: JournalEntry[];
};

export type WatermarkCorrection = {
  corrected: boolean;
  entry: JournalEntry;
  originalWhen: number;
  correctedWhen?: number;
  priorMax: number;
};

/**
 * `drizzle-kit generate` appends exactly one new entry, timestamped from
 * wall clock. Given a journal whose LAST entry is that newly generated one,
 * this raises its `when` to `priorMax + SYNTHETIC_DAY_STEP_MS` whenever it is
 * not already strictly greater than the maximum `when` of every entry before
 * it — mirroring the `<=` comparison `findWatermarkSkips` uses in
 * journal-monotonic.test.ts, which mirrors drizzle's own `<` apply check.
 *
 * Mutates `entry.when` on the journal's newest entry in place (and returns
 * it) so callers can serialize the same object back to disk.
 */
export function correctNewestEntryWatermark(
  journal: Journal,
): WatermarkCorrection {
  const { entries } = journal;
  if (entries.length === 0) {
    throw new Error("journal has no entries; nothing to correct");
  }

  const newest = entries[entries.length - 1]!;
  const priorMax = entries
    .slice(0, -1)
    .reduce((max, e) => Math.max(max, e.when), -Infinity);

  // A single-entry journal, or a newest entry already strictly above every
  // prior `when`, needs no correction.
  if (entries.length === 1 || newest.when > priorMax) {
    return { corrected: false, entry: newest, originalWhen: newest.when, priorMax };
  }

  const originalWhen = newest.when;
  const correctedWhen = priorMax + SYNTHETIC_DAY_STEP_MS;
  newest.when = correctedWhen;

  return { corrected: true, entry: newest, originalWhen, correctedWhen, priorMax };
}

function loudlyLogCorrection(result: WatermarkCorrection): void {
  const bar = "=".repeat(78);
  console.warn(
    `\n${bar}\n` +
      `JOURNAL WATERMARK CORRECTED\n` +
      `${bar}\n` +
      `Migration "${result.entry.tag}" (idx ${result.entry.idx}) was generated ` +
      `with when=${result.originalWhen}, which is not strictly greater than the ` +
      `existing journal watermark (max when=${result.priorMax} across every ` +
      `prior entry).\n\n` +
      `drizzle applies a migration only when its "when" exceeds every prior ` +
      `watermark. As generated, this migration would have been SILENTLY ` +
      `SKIPPED FOREVER on any upgrade-path database -- no error, no log, no row.\n\n` +
      `Rewrote it to when=${result.correctedWhen} (priorMax ${result.priorMax} + ${SYNTHETIC_DAY_STEP_MS}).\n\n` +
      `NOTE: this journal carries hand-set, synthetic future timestamps on ` +
      `several earlier migrations (0121-0129) rather than real wall-clock ` +
      `values -- that is deliberate scar tissue, not a bug. See ` +
      `packages/db/tests/journal-monotonic.test.ts for the full history. Do ` +
      `not infer "when this migration was written" from these numbers.\n` +
      `${bar}\n`,
  );
}

function main(): void {
  const raw = readFileSync(JOURNAL_PATH, "utf8");
  const journal = JSON.parse(raw) as Journal;
  const result = correctNewestEntryWatermark(journal);

  if (!result.corrected) {
    return;
  }

  loudlyLogCorrection(result);
  writeFileSync(JOURNAL_PATH, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  main();
}
